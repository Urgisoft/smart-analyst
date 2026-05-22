/**
 * Schedule 13D / 13G activist-stake repository — reads SEC EDGAR Schedule
 * 13D/G filing rows from `quantlab.schedule_13d_g_filings`, resolves the
 * equity-midcap watch universe + SPY-500 PIT constituent panel + GICS
 * sector mapping, composes inputs for the XD13-A2 composite, writes daily
 * snapshots (Phase XD13-A4).
 *
 * SPEC: docs/specs/schedule-13d-13g-activist-stake.md §3 (component diagram),
 *       §5.1-§5.2 (composite formulas), §6 (snapshot schema), §7 (daemon
 *       hook 1m), §9.2 (T-XD13R-1..T-XD13R-Nplus5).
 *
 * Responsibility split (mirrors form_4_insider_repository.ts +
 * eight_k_classifier_repository.ts where mechanics line up):
 *   - Pure composite logic lives in src/server/schedule_13d_g.ts (XD13-A2 —
 *     pinned). The composite is universe-agnostic — it consumes a per-ticker
 *     filing panel + a sector-aggregate panel and emits the snapshot shape.
 *   - This repository is the I/O boundary: pulls the trailing 90d filing
 *     panel per ticker from `quantlab.schedule_13d_g_filings` (where XD13-A1
 *     already stored the resolved `issuer_ticker` column on each row),
 *     resolves the equity-midcap watch universe from `quantlab.candles`,
 *     reads the SPY-500 PIT constituent panel + the issuer CIK↔ticker
 *     reverse cache + the GICS sector mapping, feeds the composite, writes
 *     the snapshot to `quantlab.schedule_13d_g_snapshots`.
 *
 * GICS sector mapping (s94 #1 / G1-A1 / shared helper since G1-A4 / S94-10):
 *   Per-ticker layer: `readSectorByTicker` reads PIT-DESC LIMIT 1 BY ticker
 *   from `quantlab.gics_sector_map`. Returns sector + sub-industry; absent
 *   rows emit `sector = null` (graceful cold-start before the GICS ingest
 *   first runs). Same pattern as EK / F4 — thin wrapper over the shared
 *   `readGicsSectorByTicker` helper.
 *
 *   Aggregate-sector layer: ACTIVE in XD13-A4 (mirrors EK / F4 G2 wiring per
 *   ADR-042 §4 / §7 / §8). `populateSectorsForCycle(asOf)` populates
 *   `inputs.sectors` with per-day rolling-90d NEW-13D-rate baselines + today's
 *   90d filings for each GICS sector represented in the SP500 PIT panel. The
 *   composite's `computeSectorNew13DRate` is reused per panel day for the
 *   baseline series; XD-5 asymmetric filter applies inside that helper (NEW
 *   13D only — amendments excluded from the aggregate baseline).
 *
 * Anti-leak gate (load-bearing per SPEC §11 / EDF-5 / XD-7):
 *   All filing reads filter on `accepted_at <= asOf` (NOT `period_of_report`).
 *   The composite's window math also uses `acceptedAt` per EDF-5. A refactor
 *   that swapped to `period_of_report` would introduce a look-ahead leak —
 *   SC 13G's period_of_report can predate acceptedAt by up to 45d under
 *   Rule 13d-1(b) (institutions file 45d after year-end). Defense in depth
 *   alongside the composite-layer T-XD13-18 anti-leak filter.
 *
 * Snapshot persistence — v1 column shape (SPEC §6):
 *   The XD13 snapshot table has 10 columns: snapshot_date, last_edgar_query_at,
 *   bd_since_last_query, schedule_13d_cluster_flag, flagged_sectors_json,
 *   per_ticker_json, inputs_available_aggregate, inputs_available_per_ticker,
 *   composite_version, ingested_at. NO `computed_at DateTime64(3)` (uses
 *   `ingested_at DateTime` for RMT versioning per S96-17). NO max_aggregate_z
 *   columns — the composite's `maxAggregateZ` + `maxAggregateZSector` are
 *   emitted at evaluation time + propagated through the daemon `aggregateLogLine`
 *   but NOT persisted in v1 (SPEC §6 deferred to a v2 add-* migration when
 *   the brief renderer needs cross-day max-z observability). On read,
 *   loadLatestSnapshot derives maxAggregateZ from flaggedSectors (sectors
 *   with |z| > 2.0 only) — this loses the "no sector flagged, but max |z|
 *   was close" signal. Acceptable for v1 brief-render parity; revisit if
 *   the renderer adds a "next closest" panel.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';
import {
  ROLLING_WINDOW_DAYS,
  SCHEDULE_13D_G_COMPOSITE_VERSION,
  SCHEDULE_13D_CLUSTER_Z_THRESHOLD,
  computeSectorNew13DRate,
  evaluateSchedule13DGComposite,
  type Schedule13DGFlaggedSector,
  type Schedule13DGInputs,
  type Schedule13DGPerTickerRow,
  type Schedule13DGSnapshot,
  type ScheduleFiling,
} from './schedule_13d_g.js';
import {
  findGoverningSector,
  readGicsSectorByTicker,
  readGicsSectorTimeline,
  readSectorMembershipPanel,
  type GicsSectorEntry,
} from './gics_sector_repository_helper.js';

/** Trailing window per XD-6 for the per-ticker rolling 90d filing panel. */
export const FILING_WINDOW_DAYS = ROLLING_WINDOW_DAYS;

/** Baseline window for the sector-aggregate z-score: 2 calendar years.
 *  Matches EK + F4 + executive-departure + short-interest + etf-flow
 *  BASELINE_CALENDAR_DAYS constant. Per EDF-7 the MIN_Z_BASELINE = 30 floor
 *  lives in the composite layer (`schedule_13d_g.ts`); this constant governs
 *  only the I/O window read by the repository for the baseline panel. */
export const BASELINE_CALENDAR_DAYS = 730;

export interface Schedule13DGRepositoryOptions {
  ch?: ClickHouseClient;
  filingsTable?: string;
  sp500ConstituentsTable?: string;
  cikTickerMapTable?: string;
  candlesTable?: string;
  snapshotsTable?: string;
  /** GICS sector map source — defaults to 'quantlab.gics_sector_map'
   *  (s94 #1 / G1-A1). */
  gicsSectorMapTable?: string;
}

export interface Schedule13DGDaemonResult {
  snapshot: Schedule13DGSnapshot;
  inputs: Schedule13DGInputs;
  summaryLine: string;
  /** Per-cycle GICS aggregate-panel log line per gics-sector-baseline-computation
   *  SPEC §1.3 (Step 5). Distinct from `summaryLine`: one line per composite
   *  per cycle, prefixed `[xd-aggregate]`, shape mirrors the EK / F4 sibling
   *  log lines so the regex pin `(xd|ek|f4)-aggregate\] … max_z=… cluster_flag=
   *  (true|false)` still matches. */
  aggregateLogLine: string;
}

interface RawFilingRow {
  accession: string;
  issuer_cik: string;
  filer_cik: string;
  filer_name: string;
  issuer_ticker: string;
  form_type: string;
  is_amendment: number | string;
  accepted_at: string;
  period_of_report: string;
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

/** Per-ticker GICS resolution shape returned by `readSectorByTicker`.
 *  Composite-specific typed alias for the shared `GicsSectorEntry` shape
 *  (see `src/server/gics_sector_repository_helper.ts`); kept distinct from
 *  the EK / F4 aliases for type-graph clarity at the consumer boundary. */
export type Schedule13DGSectorEntry = GicsSectorEntry;

interface RawSnapshotRow {
  snapshot_date: string;
  last_edgar_query_at: string | null;
  bd_since_last_query: number | string | null;
  schedule_13d_cluster_flag: number | string;
  flagged_sectors_json: string;
  per_ticker_json: string;
  inputs_available_aggregate: number | string;
  inputs_available_per_ticker: number | string;
  composite_version: string;
}

export class Schedule13DGRepository {
  private readonly ch: ClickHouseClient;
  readonly filingsTable: string;
  readonly sp500ConstituentsTable: string;
  readonly cikTickerMapTable: string;
  readonly candlesTable: string;
  readonly snapshotsTable: string;
  readonly gicsSectorMapTable: string;

  constructor(opts: Schedule13DGRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.filingsTable = opts.filingsTable ?? 'quantlab.schedule_13d_g_filings';
    this.sp500ConstituentsTable = opts.sp500ConstituentsTable ?? 'quantlab.sp500_constituents';
    this.cikTickerMapTable = opts.cikTickerMapTable ?? 'quantlab.cik_ticker_map';
    this.candlesTable = opts.candlesTable ?? 'quantlab.candles';
    this.snapshotsTable = opts.snapshotsTable ?? 'quantlab.schedule_13d_g_snapshots';
    this.gicsSectorMapTable = opts.gicsSectorMapTable ?? 'quantlab.gics_sector_map';
  }

  /**
   * Latest EDGAR acceptance datetime ≤ asOf — used for the
   * `last_edgar_query_at` + `bd_since_last_query` staleness indicators in
   * the snapshot. Returns null when no filings exist yet (table empty /
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
          FROM ${this.filingsTable} FINAL
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
   * Read all Schedule 13D/G filings with `accepted_at` in
   * `[asOf - windowDays, asOf]` for the given ticker list. The composite
   * filters internally for form type (defense in depth alongside the
   * ingest-side filter at parse time per T-XD13I-12); this read does NOT
   * narrow on form type — it returns ALL rows so that operator-side ad-hoc
   * additions to the form-type set (e.g. an SC 13E ADR) can be handled at
   * composite layer without re-ingest.
   *
   * Subquery-around-FINAL (a52c964 regression class).
   *
   * Returns a Map of issuer_ticker → filings[]. Tickers with zero filings
   * get no map entry; the consumer treats absent as empty.
   */
  async readFilingsForTickersInWindow(
    asOf: Date,
    tickers: readonly string[],
    windowDays: number = FILING_WINDOW_DAYS,
  ): Promise<Map<string, ScheduleFiling[]>> {
    if (tickers.length === 0) return new Map();
    const asOfStr = toIsoDateTime(asOf);
    const startStr = toIsoDateTime(
      new Date(asOf.getTime() - windowDays * 24 * 60 * 60 * 1000),
    );
    const q = await this.ch.query({
      query: `
        SELECT
          accession,
          issuer_cik,
          filer_cik,
          filer_name,
          issuer_ticker,
          form_type,
          is_amendment,
          toString(accepted_at) AS accepted_at,
          toString(period_of_report) AS period_of_report
        FROM (
          SELECT
            accession, issuer_cik, filer_cik, filer_name, issuer_ticker,
            form_type, is_amendment, accepted_at, period_of_report
          FROM ${this.filingsTable} FINAL
          WHERE accepted_at >= {start:DateTime}
            AND accepted_at <= {asOf:DateTime}
            AND issuer_ticker IN ({tickers:Array(String)})
        )
      `,
      query_params: {
        start: startStr,
        asOf: asOfStr,
        tickers: [...tickers],
      },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawFilingRow>();
    return groupFilingsByTicker(rows);
  }

  /**
   * Read the SPY-500 PIT constituent panel as-of asOf. Per SPEC §4 the
   * aggregate universe is "the constituent list AT the snapshot date, not
   * today's." Falls back to the latest available effective_date when no row
   * is dated ≤ asOf — matches the EK + F4 + exec-departure A4 posture.
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
   * the EK + F4 + exec-departure precedents.
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
   * tickers. Empty CIK indicates no resolution available. This is the
   * ISSUER CIK lookup, not the filer CIK — filer CIKs are read directly
   * from the `filer_cik` column on each schedule_13d_g_filings row per
   * SPEC §11 watch-out #4.
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
   * `quantlab.gics_sector_map`, PIT-DESC LIMIT 1 BY ticker. Thin wrapper
   * over the shared `readGicsSectorByTicker` helper
   * (`src/server/gics_sector_repository_helper.ts`); see EK / F4 siblings
   * for the full rationale.
   */
  async readSectorByTicker(
    asOf: Date,
    tickers: readonly string[],
  ): Promise<Map<string, Schedule13DGSectorEntry>> {
    return readGicsSectorByTicker(this.ch, this.gicsSectorMapTable, asOf, tickers);
  }

  /**
   * Compose all inputs the XD13-A2 composite needs for `asOf`. Pure-function
   * composite consumes the result; the repository does ALL I/O + windowing.
   *
   * Caller supplies the watch universe (equity-midcap symbol list) + the
   * SPY-500 PIT constituent list. The orchestrator helper
   * `runDaemonSchedule13DGEvaluation` resolves these from CH; tests inject
   * fixed lists.
   *
   * Aggregate-sector slicing: ACTIVE in v1 — `populateSectorsForCycle(asOf)`
   * populates `inputs.sectors` with per-day rolling-90d NEW-13D-rate
   * baselines + today's 90d filings for each GICS sector represented in
   * the SP500 PIT panel. The 90d filing window matches the composite's
   * `filterFilingsInWindow(..., 90)` filter; the composite's
   * `computeSectorNew13DRate` applies the XD-5 asymmetric filter
   * (NEW 13D only — amendments excluded from the aggregate baseline).
   */
  async readInputsForCycle(
    asOf: Date,
    watchUniverse: readonly string[],
    _constituents: readonly string[],
  ): Promise<Schedule13DGInputs> {
    const [latestAccepted, cikByTicker, sectorByTicker, perTickerFilings, sectors] =
      await Promise.all([
        this.readLatestAcceptedAt(asOf),
        this.readCikByTicker(watchUniverse),
        this.readSectorByTicker(asOf, watchUniverse),
        this.readFilingsForTickersInWindow(asOf, watchUniverse, FILING_WINDOW_DAYS),
        this.populateSectorsForCycle(asOf),
      ]);

    const perTicker = watchUniverse.map(ticker => ({
      ticker,
      cik: cikByTicker.get(ticker) ?? '',
      sector: sectorByTicker.get(ticker)?.sector ?? null,
      filings: perTickerFilings.get(ticker) ?? [],
    }));

    const bdSinceLastQuery = latestAccepted != null
      ? businessDaysBetween(latestAccepted, asOf)
      : null;

    return {
      asOf,
      lastEdgarQueryAt: latestAccepted,
      bdSinceLastQuery,
      perTicker,
      sectors,
    };
  }

  /**
   * Compose `inputs.sectors[]` for the XD13-A2 composite evaluator per
   * docs/specs/gics-sector-baseline-computation.md §1.2 + ADR-042 §4/§7/§8.
   * Byte-equivalent structure to the EK / F4 orchestrators; the rate helper
   * is `computeSectorNew13DRate` (XD-5 asymmetric filter applied internally
   * — NEW 13D only, amendments excluded from baseline rate).
   *
   * Workflow:
   *   1. PIT membership panel via `readSectorMembershipPanel` for the
   *      trailing 2y baseline window `[asOf - 730d, asOf - 1d]` (today
   *      EXCLUDED per ADR-042 §4).
   *   2. Today's PIT constituents + per-ticker GICS timeline for strict-PIT
   *      sector attribution.
   *   3. Trailing-2y filings for today's PIT constituents via
   *      `readFilingsForTickersInWindow`. (No form-type filter at SQL —
   *      defense-in-depth happens in `computeSectorNew13DRate`.)
   *   4. Bucket filings by governing sector on filing-acceptance day; build
   *      baseline2y[] from `computeSectorNew13DRate(sectorFilings,
   *      memberCount, dayAsOf, ROLLING_WINDOW_DAYS)` per panel day.
   *   5. Today's 90d filings sliced for `s.filings` (composite re-applies
   *      `dedupeFilings` + `filterFilingsToScheduleForms` +
   *      `filterFilingsInWindow(..., 90)` defensively before its own
   *      `computeSectorNew13DRate` call).
   */
  async populateSectorsForCycle(
    asOf: Date,
  ): Promise<Schedule13DGInputs['sectors']> {
    const oneDay = 24 * 60 * 60 * 1000;
    const baselineStart = new Date(asOf.getTime() - BASELINE_CALENDAR_DAYS * oneDay);
    const baselineEnd = new Date(asOf.getTime() - oneDay);

    const [panel, todayConstituents] = await Promise.all([
      readSectorMembershipPanel(
        this.ch,
        this.gicsSectorMapTable,
        this.sp500ConstituentsTable,
        baselineStart,
        baselineEnd,
      ),
      this.readSp500ConstituentsPIT(asOf),
    ]);

    if (todayConstituents.length === 0 && panel.length === 0) return [];

    const [timeline, filingsByTicker] = await Promise.all([
      readGicsSectorTimeline(this.ch, this.gicsSectorMapTable, todayConstituents, asOf),
      this.readFilingsForTickersInWindow(asOf, todayConstituents, BASELINE_CALENDAR_DAYS),
    ]);

    const sectorFilingsAll = new Map<string, ScheduleFiling[]>();
    for (const [ticker, filings] of filingsByTicker) {
      const tickerTimeline = timeline.get(ticker);
      if (!tickerTimeline || tickerTimeline.length === 0) continue;
      for (const f of filings) {
        const dayIso = f.acceptedAt.toISOString().slice(0, 10);
        const sector = findGoverningSector(tickerTimeline, dayIso);
        if (sector == null) continue;
        const arr = sectorFilingsAll.get(sector) ?? [];
        arr.push(f);
        sectorFilingsAll.set(sector, arr);
      }
    }

    const todayIso = asOf.toISOString().slice(0, 10);
    const sectorSizeToday = new Map<string, number>();
    for (const ticker of todayConstituents) {
      const tickerTimeline = timeline.get(ticker);
      if (!tickerTimeline || tickerTimeline.length === 0) continue;
      const sector = findGoverningSector(tickerTimeline, todayIso);
      if (sector == null) continue;
      sectorSizeToday.set(sector, (sectorSizeToday.get(sector) ?? 0) + 1);
    }

    const panelBySectorByDay = new Map<string, Map<string, number>>();
    for (const row of panel) {
      let bySector = panelBySectorByDay.get(row.sector);
      if (!bySector) {
        bySector = new Map();
        panelBySectorByDay.set(row.sector, bySector);
      }
      bySector.set(row.day, row.memberCount);
    }

    const allSectors = new Set<string>([
      ...panelBySectorByDay.keys(),
      ...sectorSizeToday.keys(),
    ]);
    const sortedSectors = [...allSectors].sort();

    const asOfMs = asOf.getTime();
    const todayWindowStartMs = asOfMs - FILING_WINDOW_DAYS * oneDay;
    const out: Array<{
      sector: string;
      sectorSize: number;
      filings: ScheduleFiling[];
      baseline2y: number[];
    }> = [];

    for (const sector of sortedSectors) {
      const panelDays = panelBySectorByDay.get(sector);
      const sectorFilings = sectorFilingsAll.get(sector) ?? [];

      const baseline2y: number[] = [];
      if (panelDays) {
        const sortedDays = [...panelDays.keys()].sort();
        for (const day of sortedDays) {
          const memberCount = panelDays.get(day)!;
          if (memberCount <= 0) continue;
          const dayAsOf = new Date(day + 'T23:59:59.999Z');
          const rate = computeSectorNew13DRate(
            sectorFilings, memberCount, dayAsOf, FILING_WINDOW_DAYS,
          );
          if (rate != null) baseline2y.push(rate);
        }
      }

      const todayFilings: ScheduleFiling[] = [];
      for (const f of sectorFilings) {
        const t = f.acceptedAt.getTime();
        if (t > todayWindowStartMs && t <= asOfMs) todayFilings.push(f);
      }

      out.push({
        sector,
        sectorSize: sectorSizeToday.get(sector) ?? 0,
        filings: todayFilings,
        baseline2y,
      });
    }

    return out;
  }

  /** Persist one snapshot. Idempotent under
   *  ReplacingMergeTree(ingested_at) on (snapshot_date, composite_version)
   *  per SPEC §6 / S96-17. The Schedule13DGSnapshot.version field maps to
   *  the DDL's `composite_version` column at this boundary (load-bearing —
   *  the table HAS a DEFAULT 'schedule_13d_g_v1' on composite_version, but
   *  the daemon writes it explicitly to forward-proof v2 coexistence on
   *  the composite ORDER BY key).
   *
   *  v1 column shape (SPEC §6): NO `computed_at` (uses `ingested_at` default);
   *  NO `max_aggregate_z` / `max_aggregate_z_sector` columns. The composite's
   *  `maxAggregateZ` + `maxAggregateZSector` are emitted in the daemon
   *  aggregate log line but NOT persisted in v1. See module header for the
   *  trade-off. */
  async writeSnapshot(snapshot: Schedule13DGSnapshot): Promise<void> {
    const snapshotDate = toIsoDate(snapshot.snapshotDate);
    const lastQueryAt = snapshot.lastEdgarQueryAt != null
      ? formatDateTime(snapshot.lastEdgarQueryAt)
      : null;
    const perTickerJson = JSON.stringify(snapshot.perTickerRows);
    const flaggedSectorsJson = JSON.stringify(snapshot.flaggedSectors);
    await this.ch.insert({
      table: this.snapshotsTable,
      values: [{
        snapshot_date: snapshotDate,
        last_edgar_query_at: lastQueryAt,
        bd_since_last_query: snapshot.bdSinceLastQuery,
        schedule_13d_cluster_flag: snapshot.schedule13DClusterFlag ? 1 : 0,
        flagged_sectors_json: flaggedSectorsJson,
        per_ticker_json: perTickerJson,
        inputs_available_aggregate: snapshot.inputsAvailableAggregate,
        inputs_available_per_ticker: snapshot.inputsAvailablePerTicker,
        composite_version: snapshot.version,
      }],
      format: 'JSONEachRow',
    });
  }

  /** Read the most-recent snapshot. Used by the morning brief (XD13-A5).
   *  Subquery-around-FINAL via the outer FROM + LIMIT 1.
   *
   *  Cross-day max-z recovery: v1 derives `maxAggregateZ` +
   *  `maxAggregateZSector` from `flaggedSectors` (sectors with |z| >
   *  THRESHOLD only). Sectors with non-null z but |z| ≤ THRESHOLD are
   *  lost on a round-trip — accepted v1 trade-off per SPEC §6 + the
   *  module header. */
  async loadLatestSnapshot(): Promise<Schedule13DGSnapshot | null> {
    const q = await this.ch.query({
      query: `
        SELECT
          toString(snapshot_date) AS snapshot_date,
          toString(last_edgar_query_at) AS last_edgar_query_at,
          bd_since_last_query,
          schedule_13d_cluster_flag,
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
    let perTickerRows: ReadonlyArray<Schedule13DGPerTickerRow> = [];
    try {
      const parsed = JSON.parse(r.per_ticker_json);
      if (Array.isArray(parsed)) {
        perTickerRows = parsed as Schedule13DGPerTickerRow[];
      }
    } catch {
      perTickerRows = [];
    }
    let flaggedSectors: ReadonlyArray<Schedule13DGFlaggedSector> = [];
    try {
      const parsed = JSON.parse(r.flagged_sectors_json);
      if (Array.isArray(parsed)) {
        flaggedSectors = parsed as Schedule13DGFlaggedSector[];
      }
    } catch {
      flaggedSectors = [];
    }

    // v1 cross-day max-z derivation: walk flaggedSectors. Pre-v2 we only
    // persist sectors with |z| > THRESHOLD, so this loses the "next-closest"
    // signal. Lexicographic tie-break matches the composite convention.
    let maxAggregateZ: number | null = null;
    let maxAggregateZSector: string | null = null;
    let maxAbsZ = -Infinity;
    for (const fs of flaggedSectors) {
      const absZ = Math.abs(fs.z);
      if (
        absZ > maxAbsZ ||
        (absZ === maxAbsZ && (maxAggregateZSector == null || fs.sector < maxAggregateZSector))
      ) {
        maxAbsZ = absZ;
        maxAggregateZ = fs.z;
        maxAggregateZSector = fs.sector;
      }
    }

    const parsedDate = parseChDateTime(r.snapshot_date);
    const snapshotDate = parsedDate ?? new Date(`${r.snapshot_date}T00:00:00.000Z`);

    return {
      snapshotDate,
      lastEdgarQueryAt: lastQueryAt,
      bdSinceLastQuery: r.bd_since_last_query != null ? Number(r.bd_since_last_query) : null,
      flaggedSectors,
      schedule13DClusterFlag: Number(r.schedule_13d_cluster_flag) === 1,
      maxAggregateZ,
      maxAggregateZSector,
      perTickerRows,
      inputsAvailableAggregate: Number(r.inputs_available_aggregate),
      inputsAvailablePerTicker: Number(r.inputs_available_per_ticker),
      version: r.composite_version as typeof SCHEDULE_13D_G_COMPOSITE_VERSION,
    };
  }

  /** Instance probe: does the source `schedule_13d_g_filings` table exist?
   *  Used internally by `runDaemonSchedule13DGEvaluation` for the SPEC §7
   *  cold-start branch (returns a cold-start snapshot, NOT a throw).
   *  Respects `this.filingsTable` so test injection of a non-default table
   *  name flows through. */
  async filingsTableExists(): Promise<boolean> {
    return tableExistsInternal(this.ch, this.filingsTable);
  }
}

// ───── helpers ──────────────────────────────────────────────────────────────

function groupFilingsByTicker(
  rows: readonly RawFilingRow[],
): Map<string, ScheduleFiling[]> {
  const out = new Map<string, ScheduleFiling[]>();
  for (const r of rows) {
    const acceptedAt = parseChDateTime(r.accepted_at);
    if (acceptedAt == null) continue;
    const periodOfReport = parseChDateTime(r.period_of_report)
      ?? new Date(`${r.period_of_report}T00:00:00.000Z`);
    const filing: ScheduleFiling = {
      accession: r.accession,
      issuerCik: r.issuer_cik,
      issuerTicker: r.issuer_ticker ?? '',
      filerCik: r.filer_cik ?? '',
      filerName: r.filer_name ?? '',
      formType: r.form_type,
      isAmendment: Number(r.is_amendment) === 1,
      acceptedAt,
      periodOfReport,
    };
    const arr = out.get(filing.issuerTicker) ?? [];
    arr.push(filing);
    out.set(filing.issuerTicker, arr);
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
 *  Mon-Fri only; holidays not accounted for. Same shape as EK + F4 +
 *  exec-departure + short-interest + etf-flow. */
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

async function tableExistsInternal(
  ch: ClickHouseClient,
  fqTable: string,
): Promise<boolean> {
  // fqTable is 'database.table'; split on the dot. Defaults pass through
  // to 'quantlab.<table>' so non-quantlab targets work in tests.
  const dot = fqTable.indexOf('.');
  const database = dot >= 0 ? fqTable.slice(0, dot) : 'quantlab';
  const name = dot >= 0 ? fqTable.slice(dot + 1) : fqTable;
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = {db:String} AND name = {tbl:String}`,
      query_params: { db: database, tbl: name },
      format: 'JSONEachRow',
    });
    const [{ n }] = await r.json<{ n: string | number }>();
    return Number(n) > 0;
  } catch {
    return false;
  }
}

/** Module-level probe: does the snapshots table exist?
 *  Mirrors the absent-table-safe gate from EK / F4 / exec-departure /
 *  etf-flow / short-interest. */
export async function schedule13dgSnapshotsTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  return tableExistsInternal(ch, 'quantlab.schedule_13d_g_snapshots');
}

/** Module-level probe: does the source `schedule_13d_g_filings` table exist?
 *  Used by the daemon to skip step 1m cleanly when the XD13-A1 ingest has
 *  never run AND the migration has not been applied. The orchestrator's
 *  internal cold-start branch handles the case "migration applied but
 *  ingest never wrote" cleanly (empty perTicker + empty sectors → cold-
 *  start snapshot), so daemon-side this gate is informational only —
 *  the orchestrator handles both states without throwing. */
export async function schedule13dgFilingsTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  return tableExistsInternal(ch, 'quantlab.schedule_13d_g_filings');
}

/**
 * Daemon orchestration: read universes → compute → persist one snapshot.
 * Wired into scripts/daily_signal_daemon.ts as step 1m (after step 1l
 * form-4, before §2 cells/bundles per SPEC §7).
 *
 * The orchestrator resolves the equity-midcap watch universe + SPY-500 PIT
 * constituents from CH, then composes + writes a single snapshot.
 *
 * **Cold-start branch (SPEC §7).** If `schedule_13d_g_filings` is missing
 * (XD13-A1 migration not applied AND ingest never ran), the orchestrator
 * synthesises an empty Schedule13DGInputs (no perTicker, no sectors,
 * lastEdgarQueryAt=null) and falls through to `evaluateSchedule13DGComposite`
 * which emits a cold-start snapshot (all flags false, counters 0).
 * Snapshot is then persisted normally — the operator's daemon-side gate
 * handles the snapshots-table-missing case.
 *
 * Pre-passed `watchUniverse` / `constituents` override the CH reads — tests
 * inject fixed lists; the daemon path lets the orchestrator resolve them
 * itself.
 */
export async function runDaemonSchedule13DGEvaluation(opts: {
  repo: Schedule13DGRepository;
  asOf: Date;
  watchUniverse?: readonly string[];
  constituents?: readonly string[];
}): Promise<Schedule13DGDaemonResult> {
  const filingsExist = await opts.repo.filingsTableExists();
  let inputs: Schedule13DGInputs;
  let watchUniverseLen = 0;
  let constituentsLen = 0;
  if (!filingsExist) {
    inputs = {
      asOf: opts.asOf,
      lastEdgarQueryAt: null,
      bdSinceLastQuery: null,
      perTicker: [],
      sectors: [],
    };
  } else {
    const watchUniverse = opts.watchUniverse
      ?? await opts.repo.readEquityMidcapWatchUniverse();
    const constituents = opts.constituents
      ?? await opts.repo.readSp500ConstituentsPIT(opts.asOf);
    watchUniverseLen = watchUniverse.length;
    constituentsLen = constituents.length;
    inputs = await opts.repo.readInputsForCycle(opts.asOf, watchUniverse, constituents);
  }
  const snapshot = evaluateSchedule13DGComposite(inputs);
  await opts.repo.writeSnapshot(snapshot);

  const flaggedTickers = snapshot.perTickerRows.filter(
    r => r.new13DFilingFlag30d || r.new13GFilingFlag30d,
  ).length;
  const lastQueryStr = snapshot.lastEdgarQueryAt != null
    ? toIsoDate(snapshot.lastEdgarQueryAt)
    : '—';
  const bdSince = snapshot.bdSinceLastQuery;
  const summaryLine =
    `[schedule-13d-g] ${toIsoDate(opts.asOf)} ` +
    `cluster=${snapshot.schedule13DClusterFlag ? 'YES' : 'NO'} ` +
    `flagged_sectors=${snapshot.flaggedSectors.length} ` +
    `flagged_tickers=${flaggedTickers} ` +
    `universe=${snapshot.inputsAvailablePerTicker}/${watchUniverseLen} ` +
    `agg=${snapshot.inputsAvailableAggregate}/${constituentsLen} ` +
    `last_edgar=${lastQueryStr} (${bdSince != null ? `${bdSince}bd` : '—'})`;

  // gics-sector-baseline-computation.md §1.3 (Step 5) per-cycle aggregate log.
  // Tokenization mirrors EK + F4 sibling log lines so the shared regex pin
  // `(xd|ek|f4)-aggregate\] … max_z=… cluster_flag=(true|false)` matches.
  const aggMaxSector = snapshot.maxAggregateZSector;
  const aggMaxZ = snapshot.maxAggregateZ;
  const aggMaxToken = aggMaxSector != null && aggMaxZ != null
    ? `${aggMaxSector.replace(/\s+/g, '_')}:${aggMaxZ.toFixed(2)}`
    : 'n/a:n/a';
  const aggregateLogLine =
    `[xd-aggregate] sectors_with_z=${snapshot.inputsAvailableAggregate}/11 ` +
    `floor_cleared=${snapshot.inputsAvailableAggregate}/11 ` +
    `max_z=${aggMaxToken} ` +
    `cluster_flag=${snapshot.schedule13DClusterFlag ? 'true' : 'false'}`;

  return { snapshot, inputs, summaryLine, aggregateLogLine };
}

/** Composite-version re-export for daemon-side log-line tagging. */
export { SCHEDULE_13D_G_COMPOSITE_VERSION, SCHEDULE_13D_CLUSTER_Z_THRESHOLD };

/**
 * What could break this:
 *   - **SPEC §6 omits max_aggregate_z columns.** writeSnapshot does NOT
 *     write `max_aggregate_z` / `max_aggregate_z_sector`. The composite's
 *     `maxAggregateZ` + `maxAggregateZSector` are emitted in the daemon
 *     `aggregateLogLine` AND in the live in-memory snapshot, but lost on
 *     a CH round-trip. loadLatestSnapshot derives them from `flaggedSectors`
 *     (sectors with |z| > THRESHOLD only) — "next closest" sectors
 *     (|z| ≤ THRESHOLD) are lost. A v2 ADR + add-* migration may add the
 *     columns when the brief renderer needs cross-day "next-closest"
 *     observability.
 *   - **SPEC §6 uses `ingested_at DateTime` for RMT versioning, NOT
 *     `computed_at DateTime64(3)` (S96-17).** snapshot_date is `Date`
 *     resolution — writeSnapshot strips hours/minutes/seconds. loadLatest
 *     reconstructs `snapshotDate` as `Date at 00:00:00 UTC`. The daemon
 *     writes at-most-once per snapshot_date so this is fine; round-trip
 *     loses asOf time-of-day deliberately.
 *   - **XD-5 asymmetric filter (load-bearing at composite layer).**
 *     `populateSectorsForCycle` reads ALL form types in 2y window, then
 *     `computeSectorNew13DRate` filters to NEW 13D only at baseline-rate
 *     compute time. Inverting the filter at the repository (e.g. SQL-
 *     side `WHERE form_type = 'SC 13D'`) silently corrupts the per-stock
 *     panel of `populateSectorsForCycle`'s today-slice — the today-slice
 *     `s.filings` would then drop 13G + amendments, breaking the
 *     composite's defense-in-depth re-filter.
 *   - **Filer CIK ≠ issuer CIK (SPEC §11 watch-out #4).** readCikByTicker
 *     returns ISSUER CIKs only. Filer CIKs are read straight from the
 *     `filer_cik` column on each schedule_13d_g_filings row; no JOIN at
 *     composite-eval time.
 *   - **Anti-leak: acceptedAt only.** Both readLatestAcceptedAt +
 *     readFilingsForTickersInWindow filter on `accepted_at`, NEVER on
 *     `period_of_report`. SC 13G's period_of_report can predate
 *     acceptance by up to 45d (Rule 13d-1(b) — institutions file 45d
 *     after year-end). Defense in depth alongside the composite-layer
 *     T-XD13-18 gate.
 *   - **No form-type filter in readFilingsForTickersInWindow SQL.** Unlike
 *     EK (which narrows on item_code IN HIGH_SIGNAL_ITEM_CODES) and F4
 *     (which narrows on transaction_code IN {P, S}), this repository reads
 *     ALL form types in the window. The composite's
 *     `filterFilingsToScheduleForms` is the only filter that narrows to
 *     {SC 13D, SC 13D/A, SC 13G, SC 13G/A}. Rationale: the XD13-A1 ingest
 *     filters at parse time to the SPEC set (T-XD13I-12), so the source
 *     table already has only the four form types — narrowing on read
 *     would be redundant. If a future ADR broadens the ingest filter
 *     (e.g. SC 13E forms), the composite-layer filter automatically
 *     handles the inclusion or exclusion via SCHEDULE_FORM_TYPES.
 *   - **Cold-start branch in orchestrator (SPEC §7).** When
 *     schedule_13d_g_filings is missing, runDaemonSchedule13DGEvaluation
 *     synthesises empty Schedule13DGInputs and falls through to
 *     evaluateSchedule13DGComposite → writeSnapshot. The write still
 *     requires the snapshots table to exist; the daemon-side gate at
 *     scripts/daily_signal_daemon.ts step 1m handles snapshots-absent
 *     separately.
 *   - **bdSinceLastQuery uses business days (Mon-Fri).** Holidays not
 *     accounted for. Same staleness rough-signal posture as EK / F4 /
 *     exec-departure / etf-flow.
 *   - **Empty watch universe / empty constituents propagate cleanly.**
 *     readInputsForCycle returns empty perTicker + empty sectors;
 *     composite emits all-zero snapshot; cluster_flag = false. The
 *     daemon's anomaly push handles operator visibility.
 *   - **EDGAR `effective_date` PIT fallback.** readSp500ConstituentsPIT
 *     falls back to the latest effective_date when no row dated ≤ asOf
 *     exists — matches EK + F4 + exec-departure A4 posture.
 *   - **GICS sector resolution.** readSectorByTicker uses PIT-DESC LIMIT 1
 *     BY ticker — handles both today-only v1 snapshot ingest AND a future
 *     v2 PIT backfill. Empty map at cold-start; consumer treats absent as
 *     "sector unknown" + the composite emits perTicker[].sector = null.
 *   - **Idempotency under ReplacingMergeTree.** The composite ORDER BY at
 *     storage is (snapshot_date, composite_version) per S96-17. Multiple
 *     daemon runs on the same day collapse to the latest write (FINAL
 *     resolves by `ingested_at` DESC). v2 coexistence (e.g.
 *     schedule_13d_g_v2 rows alongside _v1) is preserved by the composite
 *     ORDER BY key.
 */
