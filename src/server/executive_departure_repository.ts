/**
 * Executive-departure repository — reads SEC EDGAR 8-K Item 5.02 events,
 * resolves the equity-midcap watch universe + SPY-500 PIT constituent panel,
 * composes inputs for the A2 composite, writes daily snapshots (Phase A4).
 *
 * SPEC: docs/specs/executive-departure-signal.md §3 (component diagram),
 *       §5 (composite formulas), §6 (snapshot schema), §7 (daemon hook),
 *       §10 Phase A4 (this unit).
 *
 * Responsibility split (mirrors short_interest_repository.ts and
 * eight_k_classifier_repository.ts byte-for-byte where mechanics line up):
 *   - Pure composite logic lives in src/server/executive_departure.ts.
 *   - This repository is the I/O boundary: pulls the trailing 90d event panel
 *     per ticker from `quantlab.executive_departures`, the SPY-500 PIT
 *     constituent panel + GICS sector slicing (per-ticker active from G1-A4
 *     wiring below; aggregate still pending OQ-G2-1 ADR), the per-sector
 *     trailing 2y daily departure-rate baselines, the CIK↔ticker reverse
 *     cache; feeds the composite; writes the snapshot to
 *     quantlab.executive_departure_snapshots.
 *
 * GICS sector mapping — gap #7+#8 v2 G1-A4 wiring (s94 #4; UPGRADED from
 * v1 null-sector posture; third per-composite mirror of the s94 #1 shared
 * `quantlab.gics_sector_map` infrastructure per HANDOFF S94-5..S94-11):
 *
 *   SPEC §5 + §6 formulate the aggregate signal at the GICS-sector slice of
 *   the SPY-500 constituent panel. The shared `quantlab.gics_sector_map`
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
 *   Aggregate-sector layer: STILL DORMANT in G1-A4 — `inputs.sectors` remains
 *   an empty array. The aggregate layer needs a per-sector daily departure-
 *   rate 2y baseline; the baseline-computation strategy (re-compute vs
 *   persist sibling table vs hybrid) is OQ-G2-1, a separate operator ADR.
 *   Activation ships as G2 once the ADR lands.
 *
 *   Three-criterion analysis (canon-thin fork resolution per CLAUDE.md): the
 *   per-ticker / aggregate decomposition has zero free parameters, mirrors
 *   the PIT-DESC pattern used elsewhere in the repository (see
 *   readSp500ConstituentsPIT), and aligns the consumer read pattern with v2
 *   PIT backfill without touching the schema (s94 #1 S94-2 lock). The
 *   readSectorByTicker SQL shape is byte-equal to form_4_insider_repository.ts
 *   AND eight_k_classifier_repository.ts per S94-5; G1-A4 is the third copy
 *   that triggers the rule-of-three extraction evaluation per S94-10.
 *
 * Anti-leak gate (load-bearing per E-7):
 *   All event reads filter on `accepted_at <= asOf` (NOT `period_of_report`).
 *   A refactor that swapped to period_of_report would introduce a look-ahead
 *   leak — filings can be retroactively dated up to 4bd before acceptance
 *   under Sarbanes-Oxley §409 / 17 CFR 249.308.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';
import {
  computeSectorDepartureRate,
  evaluateExecutiveDepartureComposite,
  EXECUTIVE_DEPARTURE_COMPOSITE_VERSION,
  ROLLING_WINDOW_DAYS,
  type ExecutiveDepartureEvent,
  type ExecutiveDepartureFlaggedSector,
  type ExecutiveDepartureInputs,
  type ExecutiveDeparturePerTickerRow,
  type ExecutiveDepartureSnapshot,
} from './executive_departure.js';
import {
  findGoverningSector,
  readGicsSectorByTicker,
  readGicsSectorTimeline,
  readSectorMembershipPanel,
  type GicsSectorEntry,
} from './gics_sector_repository_helper.js';

/** Baseline window for sector-aggregate z-score: 2 calendar years.
 *  Matches the short-interest BASELINE_CALENDAR_DAYS constant. Per E-14 the
 *  MIN_Z_BASELINE = 30 floor lives in the composite layer; this constant
 *  governs only the I/O window read by the repository. */
export const BASELINE_CALENDAR_DAYS = 730;

/** Trailing window per E-3 for the per-ticker rolling-window flag. */
export const EVENT_WINDOW_DAYS = ROLLING_WINDOW_DAYS;

/** Composite reads 5.02(b) and 5.02(c) only per E-2; (a)/(d)/(e) are stored
 *  by A1 for forensic reference but unused here. The repository can fetch
 *  the broader set and let the composite filter — keeping the read narrow
 *  shrinks the CH transfer size. */
export const COMPOSITE_SUB_ITEM_CODES = ['5.02(b)', '5.02(c)'] as const;

export interface ExecutiveDepartureRepositoryOptions {
  ch?: ClickHouseClient;
  eventsTable?: string;
  sp500ConstituentsTable?: string;
  cikTickerMapTable?: string;
  candlesTable?: string;
  snapshotsTable?: string;
  /** GICS sector map source — defaults to 'quantlab.gics_sector_map'
   *  (s94 #1 / G1-A1). Read by `readSectorByTicker` for the per-ticker
   *  sector annotation in section #12 of the morning brief. */
  gicsSectorMapTable?: string;
}

export interface ExecutiveDepartureDaemonResult {
  snapshot: ExecutiveDepartureSnapshot;
  inputs: ExecutiveDepartureInputs;
  summaryLine: string;
  /** Per-cycle GICS aggregate-panel log line per gics-sector-baseline-computation
   *  SPEC §1.3 (Step 5). Distinct from `summaryLine`: one line per composite per
   *  cycle, prefixed `[xd-aggregate]`, shape pinned by §5.5 regex G2-DAEMON-XD-1.
   *  v1 semantic per ADR-042 §"Watch-outs" (Option C): `sectors_with_z` and
   *  `floor_cleared` both report `inputsAvailableAggregate` — the floor's only
   *  practical failure is the empty-baseline2y cold-start case (which fires only
   *  when inputsAvailableAggregate=0), so the two counts agree in v1. v2
   *  tightening (separate `sectorsClearedFloor` snapshot field) is operator-
   *  pickable per HANDOFF.md s94 #10 NEXT. */
  aggregateLogLine: string;
}

interface RawEventRow {
  ticker: string;
  cik: string;
  accession: string;
  sub_item_code: string;
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

/** Per-ticker GICS resolution shape returned by `readSectorByTicker`.
 *  Composite-specific typed alias for the shared `GicsSectorEntry` shape
 *  (see `src/server/gics_sector_repository_helper.ts`); kept distinct from
 *  the F4 / EK aliases for type-graph clarity at the consumer boundary.
 *  `subIndustry` is captured at ingest but currently UNUSED by the
 *  G1-A4 brief render (v3 enhancement); the field is exposed for
 *  forensic/operator queries against the snapshot JSON. */
export type ExecutiveDepartureSectorEntry = GicsSectorEntry;

interface RawSnapshotRow {
  snapshot_date: string;
  computed_at_ms: string | number;
  last_edgar_query_at: string | null;
  bd_since_last_query: number | null;
  executive_cluster_departure: number | string;
  flagged_sectors_json: string;
  per_ticker_json: string;
  inputs_available_aggregate: number | string;
  inputs_available_per_ticker: number | string;
  composite_version: string;
  // OQ-G3-1 / s94 #8 strategy (β) persistence wiring — see G2 SPEC §2 + HANDOFF
  // S94-22. Both columns are Nullable; CH renders as `number | null` /
  // `string | null` under JSONEachRow.
  max_aggregate_z: number | string | null;
  max_aggregate_z_sector: string | null;
}

export class ExecutiveDepartureRepository {
  private readonly ch: ClickHouseClient;
  readonly eventsTable: string;
  readonly sp500ConstituentsTable: string;
  readonly cikTickerMapTable: string;
  readonly candlesTable: string;
  readonly snapshotsTable: string;
  readonly gicsSectorMapTable: string;

  constructor(opts: ExecutiveDepartureRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.eventsTable = opts.eventsTable ?? 'quantlab.executive_departures';
    this.sp500ConstituentsTable = opts.sp500ConstituentsTable ?? 'quantlab.sp500_constituents';
    this.cikTickerMapTable = opts.cikTickerMapTable ?? 'quantlab.cik_ticker_map';
    this.candlesTable = opts.candlesTable ?? 'quantlab.candles';
    this.snapshotsTable = opts.snapshotsTable ?? 'quantlab.executive_departure_snapshots';
    this.gicsSectorMapTable = opts.gicsSectorMapTable ?? 'quantlab.gics_sector_map';
  }

  /**
   * Latest EDGAR acceptance datetime ≤ asOf — used for the
   * `last_edgar_query_at` + `bd_since_last_query` staleness indicators in
   * the snapshot. Returns null when no events exist yet (table empty /
   * pre-first-ingest).
   */
  async readLatestAcceptedAt(asOf: Date): Promise<Date | null> {
    const asOfStr = toIsoDateTime(asOf);
    const q = await this.ch.query({
      query: `
        SELECT toString(max(accepted_at)) AS last
        FROM ${this.eventsTable} FINAL
        WHERE accepted_at <= {asOf:DateTime}
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
   * Read all Item 5.02(b)/(c) events with `accepted_at` in
   * `[asOf - windowDays, asOf]` for the given ticker list. Subquery-around-
   * FINAL (a52c964 regression class). The composite filters internally,
   * but narrowing to (b)/(c) at read time saves bytes for the common case
   * where (a)/(d)/(e) are present in the table.
   *
   * Returns a Map of ticker → events[]. Tickers with zero events get an
   * empty array on the consumer side (not present in the map).
   */
  async readEventsForTickersInWindow(
    asOf: Date,
    tickers: readonly string[],
    windowDays: number = EVENT_WINDOW_DAYS,
  ): Promise<Map<string, ExecutiveDepartureEvent[]>> {
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
          sub_item_code,
          toString(accepted_at) AS accepted_at
        FROM (
          SELECT
            ticker, cik, accession, sub_item_code, accepted_at
          FROM ${this.eventsTable} FINAL
          WHERE accepted_at >= {start:DateTime}
            AND accepted_at <= {asOf:DateTime}
            AND ticker IN ({tickers:Array(String)})
            AND sub_item_code IN ({subs:Array(String)})
        )
      `,
      query_params: {
        start: startStr,
        asOf: asOfStr,
        tickers: [...tickers],
        subs: [...COMPOSITE_SUB_ITEM_CODES],
      },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawEventRow>();
    return groupEventsByTicker(rows);
  }

  /**
   * Read all Item 5.02(b) events with `accepted_at` in the trailing 2y
   * window for the SPY-500 constituent panel. Used for the per-sector
   * trailing-2y daily departure-rate baseline.
   *
   * The repository returns the raw event list; the daemon orchestrator
   * (`runDaemonExecutiveDepartureEvaluation`) is responsible for slicing
   * into sector buckets + rolling the daily panel. v1 sector slicing is
   * inactive — see module header.
   *
   * Returns a Map of ticker → events[] (5.02(b) only).
   */
  async readDepartureEventsForBaseline(
    asOf: Date,
    tickers: readonly string[],
    days: number = BASELINE_CALENDAR_DAYS,
  ): Promise<Map<string, ExecutiveDepartureEvent[]>> {
    if (tickers.length === 0) return new Map();
    const asOfStr = toIsoDateTime(asOf);
    const startStr = toIsoDateTime(
      new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000),
    );
    const q = await this.ch.query({
      query: `
        SELECT
          ticker,
          cik,
          accession,
          sub_item_code,
          toString(accepted_at) AS accepted_at
        FROM (
          SELECT
            ticker, cik, accession, sub_item_code, accepted_at
          FROM ${this.eventsTable} FINAL
          WHERE accepted_at >= {start:DateTime}
            AND accepted_at <= {asOf:DateTime}
            AND ticker IN ({tickers:Array(String)})
            AND sub_item_code = '5.02(b)'
        )
      `,
      query_params: {
        start: startStr,
        asOf: asOfStr,
        tickers: [...tickers],
      },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawEventRow>();
    return groupEventsByTicker(rows);
  }

  /**
   * Read the SPY-500 PIT constituent panel as-of asOf. Per E-6 the
   * aggregate universe is "the constituent list AT the snapshot date, not
   * today's." Falls back to the latest available effective_date when no row
   * is dated ≤ asOf — matches the short-interest A4 posture.
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
   * the short-interest A4 precedent.
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
   * tickers. Empty CIK indicates no resolution available (composite's
   * `inputsAvailablePerTicker` counts only rows with non-empty CIK + sector).
   * The map is one-way (ticker → cik); A1's `formerNames` chain stores
   * historical aliases on the same row but the daemon needs only the
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
   * Thin wrapper over the shared `readGicsSectorByTicker` helper
   * (`src/server/gics_sector_repository_helper.ts`) — extracted at G1-A4 per
   * S94-10's rule-of-three (third byte-equal copy across F4 / EK / XD).
   * The helper owns the SQL + parsing; this wrapper only narrows the return
   * type to `ExecutiveDepartureSectorEntry` for type-graph clarity at the
   * composite-API boundary.
   */
  async readSectorByTicker(
    asOf: Date,
    tickers: readonly string[],
  ): Promise<Map<string, ExecutiveDepartureSectorEntry>> {
    return readGicsSectorByTicker(this.ch, this.gicsSectorMapTable, asOf, tickers);
  }

  /**
   * Compose all inputs the A2 composite needs for `asOf`. Pure-function
   * composite consumes the result; the repository does ALL I/O + windowing.
   *
   * Caller supplies the watch universe (equity-midcap symbol list) + the
   * SPY-500 PIT constituent list. The orchestrator helper
   * `runDaemonExecutiveDepartureEvaluation` resolves these from CH; tests
   * inject fixed lists.
   *
   * Per-ticker sector resolution: G1-A4 wiring (s94 #4) — sector + sub-
   * industry resolved from `quantlab.gics_sector_map` via PIT-DESC LIMIT 1
   * BY ticker. Composite's `inputsAvailablePerTicker` now counts rows with
   * BOTH a CIK + a sector (previously structurally 0 in v1 cold-start).
   *
   * Aggregate-sector slicing: ACTIVE since s94 #9 (G2 Step 3 per
   * docs/specs/gics-sector-baseline-computation.md §6 / ADR-042 Option a) —
   * `populateSectorsForCycle(asOf)` populates `inputs.sectors` with per-day
   * rolling-90d departure-rate baselines + today's 90d events for each GICS
   * sector represented in the SP500 PIT panel.
   */
  async readInputsForCycle(
    asOf: Date,
    watchUniverse: readonly string[],
    _constituents: readonly string[],
  ): Promise<ExecutiveDepartureInputs> {
    const [latestAccepted, cikByTicker, sectorByTicker, perTickerEvents, sectors] =
      await Promise.all([
        this.readLatestAcceptedAt(asOf),
        this.readCikByTicker(watchUniverse),
        this.readSectorByTicker(asOf, watchUniverse),
        this.readEventsForTickersInWindow(asOf, watchUniverse, EVENT_WINDOW_DAYS),
        this.populateSectorsForCycle(asOf),
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
      sectors,
    };
  }

  /**
   * Compose `inputs.sectors[]` for the composite evaluator per
   * docs/specs/gics-sector-baseline-computation.md §1.2 + ADR-042 §4/§7/§8.
   *
   * Workflow:
   *   1. PIT membership panel via `readSectorMembershipPanel` for the trailing
   *      2y baseline window `[asOf - 730d, asOf - 1d]` (today EXCLUDED per
   *      ADR-042 §4).
   *   2. Today's PIT constituents via `readSp500ConstituentsPIT(asOf)` + per-
   *      ticker GICS timeline via `readGicsSectorTimeline` (strict-PIT sector
   *      attribution per ADR-042 §7).
   *   3. Trailing-2y 5.02(b) events for today's PIT constituents via
   *      `readDepartureEventsForBaseline` (already filters to '5.02(b)' per
   *      composite intake spec E-2).
   *   4. Bucket events by `(governing-sector-on-event-day)`; for each sector,
   *      build the baseline2y[] panel where each entry = rolling-90d
   *      departure-rate as-of day d (reuses composite's
   *      `computeSectorDepartureRate` for unit consistency with the live
   *      rate). Empty-sector days yield rate=0 per ADR-042 §8 (NOT dropped
   *      from baseline2y).
   *   5. Today's events for `s.events`: the (asOf - 90d, asOf] slice of
   *      sector events (matches composite's `windowDays = ROLLING_WINDOW_DAYS`
   *      = 90 default in `computeSectorDepartureRate`).
   *
   * Methodology choice (Path A — rolling rates):
   *   The live aggregate rate is rolling-90d per the composite's locked
   *   `windowDays = 90` default; each baseline2y[i] is also rolling-90d
   *   as-of day d for unit consistency. SPEC §1.2 line 71-72 confirms the
   *   "today's events" window is 90d, not single-day. Per-day windows near
   *   the start of the baseline window are truncated at `[asOf - 730d, d]`
   *   (~12% of baseline days affected); this v1 bias is small + favorable
   *   (under-counts events, slightly inflates z-magnitude for true outliers
   *   without introducing false positives).
   *
   * V1 simplifications (documented in watch-outs):
   *   - Event-query universe is `todayConstituents` only. Historical-only
   *     tickers (in SP500 at some point in trailing-2y but not today) have
   *     their events dropped from baseline attribution. Consistent with v1
   *     `gics_sector_map` snapshot-on-ingest schema (no historical ticker
   *     coverage); a v2 widening would pull all-time-constituents + read
   *     their sector timelines too.
   *   - Sector attribution uses strict-PIT against `gics_sector_map`'s
   *     timeline (POPSEC-XD-2 verified). v1 ingest writes a single
   *     snapshot_date per ticker, so every event resolves to today's sector;
   *     v2 PIT backfill via Wikipedia changelog would naturally activate
   *     mid-window swap support without code changes here.
   *
   * Returns one `{sector, sectorSize, events, baseline2y}` entry per GICS
   * sector represented in the panel OR today's PIT constituents (per
   * ADR-042 §8 "only sectors with memberCount=0 across the entire window
   * drop out"). Sorted by sector name for determinism.
   *
   * @param asOf Snapshot anchor (UTC end-of-day semantic).
   */
  async populateSectorsForCycle(
    asOf: Date,
  ): Promise<ExecutiveDepartureInputs['sectors']> {
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

    const [timeline, eventsByTicker] = await Promise.all([
      readGicsSectorTimeline(this.ch, this.gicsSectorMapTable, todayConstituents, asOf),
      this.readDepartureEventsForBaseline(asOf, todayConstituents, BASELINE_CALENDAR_DAYS),
    ]);

    // Bucket events by their PIT-governing sector on the event acceptance day.
    const sectorEventsAll = new Map<string, ExecutiveDepartureEvent[]>();
    for (const [ticker, events] of eventsByTicker) {
      const tickerTimeline = timeline.get(ticker);
      if (!tickerTimeline || tickerTimeline.length === 0) continue;
      for (const ev of events) {
        const dayIso = ev.acceptedAt.toISOString().slice(0, 10);
        const sector = findGoverningSector(tickerTimeline, dayIso);
        if (sector == null) continue;
        const arr = sectorEventsAll.get(sector) ?? [];
        arr.push(ev);
        sectorEventsAll.set(sector, arr);
      }
    }

    // Today's sectorSize per sector (governing sector at asOf).
    const todayIso = asOf.toISOString().slice(0, 10);
    const sectorSizeToday = new Map<string, number>();
    for (const ticker of todayConstituents) {
      const tickerTimeline = timeline.get(ticker);
      if (!tickerTimeline || tickerTimeline.length === 0) continue;
      const sector = findGoverningSector(tickerTimeline, todayIso);
      if (sector == null) continue;
      sectorSizeToday.set(sector, (sectorSizeToday.get(sector) ?? 0) + 1);
    }

    // (sector, day) → memberCount lookup for the baseline-day denominator.
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
    const todayWindowStartMs = asOfMs - EVENT_WINDOW_DAYS * oneDay;
    const out: Array<{
      sector: string;
      sectorSize: number;
      events: ExecutiveDepartureEvent[];
      baseline2y: number[];
    }> = [];

    for (const sector of sortedSectors) {
      const panelDays = panelBySectorByDay.get(sector);
      const sectorEvents = sectorEventsAll.get(sector) ?? [];

      const baseline2y: number[] = [];
      if (panelDays) {
        const sortedDays = [...panelDays.keys()].sort();
        for (const day of sortedDays) {
          const memberCount = panelDays.get(day)!;
          if (memberCount <= 0) continue;
          // End-of-day asOf semantic so events accepted on `day` are included.
          const dayAsOf = new Date(day + 'T23:59:59.999Z');
          const rate = computeSectorDepartureRate(
            sectorEvents, memberCount, dayAsOf, EVENT_WINDOW_DAYS,
          );
          // ADR-042 §8: empty-sector days yield rate=0 (NOT null). Since
          // memberCount > 0 here, computeSectorDepartureRate returns a finite
          // rate (0 when no events in the trailing-90d window).
          if (rate != null) baseline2y.push(rate);
        }
      }

      const todayEvents: ExecutiveDepartureEvent[] = [];
      for (const ev of sectorEvents) {
        const t = ev.acceptedAt.getTime();
        if (t > todayWindowStartMs && t <= asOfMs) todayEvents.push(ev);
      }

      out.push({
        sector,
        sectorSize: sectorSizeToday.get(sector) ?? 0,
        events: todayEvents,
        baseline2y,
      });
    }

    return out;
  }

  /** Persist one snapshot. Idempotent under
   *  ReplacingMergeTree(computed_at) on (snapshot_date) per A3 schema. */
  async writeSnapshot(snapshot: ExecutiveDepartureSnapshot): Promise<void> {
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
        executive_cluster_departure: snapshot.executiveClusterDeparture ? 1 : 0,
        flagged_sectors_json: flaggedSectorsJson,
        per_ticker_json: perTickerJson,
        inputs_available_aggregate: snapshot.inputsAvailableAggregate,
        inputs_available_per_ticker: snapshot.inputsAvailablePerTicker,
        composite_version: snapshot.version,
        // OQ-G3-1 / s94 #8 strategy (β) persistence wiring. Columns added by
        // migrate_add_max_aggregate_z_to_executive_departure_snapshots.ts;
        // SPEC docs/specs/gics-sector-baseline-computation.md §2.
        max_aggregate_z: snapshot.maxAggregateZ,
        max_aggregate_z_sector: snapshot.maxAggregateZSector,
      }],
      format: 'JSONEachRow',
    });
  }

  /** Read the most-recent snapshot. Used by the morning brief (A5). */
  async loadLatestSnapshot(): Promise<ExecutiveDepartureSnapshot | null> {
    const q = await this.ch.query({
      query: `
        SELECT
          toString(snapshot_date) AS snapshot_date,
          toUnixTimestamp64Milli(computed_at) AS computed_at_ms,
          toString(last_edgar_query_at) AS last_edgar_query_at,
          bd_since_last_query,
          executive_cluster_departure,
          flagged_sectors_json,
          per_ticker_json,
          inputs_available_aggregate,
          inputs_available_per_ticker,
          composite_version,
          max_aggregate_z,
          max_aggregate_z_sector
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
    let perTickerRows: ReadonlyArray<ExecutiveDeparturePerTickerRow> = [];
    try {
      const parsed = JSON.parse(r.per_ticker_json);
      if (Array.isArray(parsed)) {
        perTickerRows = parsed as ExecutiveDeparturePerTickerRow[];
      }
    } catch {
      perTickerRows = [];
    }
    let flaggedSectors: ReadonlyArray<ExecutiveDepartureFlaggedSector> = [];
    try {
      const parsed = JSON.parse(r.flagged_sectors_json);
      if (Array.isArray(parsed)) {
        flaggedSectors = parsed as ExecutiveDepartureFlaggedSector[];
      }
    } catch {
      flaggedSectors = [];
    }
    return {
      snapshotDate: new Date(Number(r.computed_at_ms)),
      lastEdgarQueryAt: lastQueryAt,
      bdSinceLastQuery: r.bd_since_last_query != null ? Number(r.bd_since_last_query) : null,
      flaggedSectors,
      executiveClusterDeparture: Number(r.executive_cluster_departure) === 1,
      // OQ-G3-1 / s94 #8 strategy (β): max-z observability now persisted via
      // the structured columns added by
      // migrate_add_max_aggregate_z_to_executive_departure_snapshots.ts.
      // Pre-migration rows resolve as NULL on read (cold-start semantic);
      // Step 4 renderer treats null as the SPEC §1.4 cold-start branch.
      maxAggregateZ: r.max_aggregate_z != null ? Number(r.max_aggregate_z) : null,
      maxAggregateZSector: r.max_aggregate_z_sector ?? null,
      perTickerRows,
      inputsAvailableAggregate: Number(r.inputs_available_aggregate),
      inputsAvailablePerTicker: Number(r.inputs_available_per_ticker),
      version: r.composite_version as typeof EXECUTIVE_DEPARTURE_COMPOSITE_VERSION,
    };
  }
}

// ───── helpers ──────────────────────────────────────────────────────────────

function groupEventsByTicker(
  rows: readonly RawEventRow[],
): Map<string, ExecutiveDepartureEvent[]> {
  const out = new Map<string, ExecutiveDepartureEvent[]>();
  for (const r of rows) {
    const acceptedAt = parseChDateTime(r.accepted_at);
    if (acceptedAt == null) continue;
    const event: ExecutiveDepartureEvent = {
      accession: r.accession,
      cik: r.cik,
      ticker: r.ticker ?? '',
      subItemCode: r.sub_item_code,
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
 *  Mon-Fri only; holidays not accounted for. Same shape as short-interest. */
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
 *  Mirrors the absent-table-safe gate from short_interest_repository. */
export async function executiveDepartureSnapshotsTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'executive_departure_snapshots'`,
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
 * Wired into scripts/daily_signal_daemon.ts as step 1i (after step 1h
 * short-interest).
 *
 * The orchestrator resolves the equity-midcap watch universe + SPY-500 PIT
 * constituents from CH, then composes + writes a single snapshot.
 *
 * Pre-passed `watchUniverse` / `constituents` override the CH reads —
 * tests inject fixed lists; the daemon path lets the orchestrator resolve
 * them itself.
 */
export async function runDaemonExecutiveDepartureEvaluation(opts: {
  repo: ExecutiveDepartureRepository;
  asOf: Date;
  watchUniverse?: readonly string[];
  constituents?: readonly string[];
}): Promise<ExecutiveDepartureDaemonResult> {
  const watchUniverse = opts.watchUniverse
    ?? await opts.repo.readEquityMidcapWatchUniverse();
  const constituents = opts.constituents
    ?? await opts.repo.readSp500ConstituentsPIT(opts.asOf);
  const inputs = await opts.repo.readInputsForCycle(opts.asOf, watchUniverse, constituents);
  const snapshot = evaluateExecutiveDepartureComposite(inputs);
  await opts.repo.writeSnapshot(snapshot);

  const flaggedDep = snapshot.perTickerRows.filter(r => r.executiveDepartureFlag).length;
  const flaggedAppt = snapshot.perTickerRows.filter(r => r.executiveAppointmentFlag).length;
  const lastQueryStr = snapshot.lastEdgarQueryAt != null
    ? toIsoDate(snapshot.lastEdgarQueryAt)
    : '—';
  const bdSince = snapshot.bdSinceLastQuery;
  const summaryLine =
    `[exec-departure] ${toIsoDate(opts.asOf)} ` +
    `cluster=${snapshot.executiveClusterDeparture ? 'YES' : 'NO'} ` +
    `flagged_sectors=${snapshot.flaggedSectors.length} ` +
    `flagged=dep:${flaggedDep}/appt:${flaggedAppt} ` +
    `universe=${snapshot.inputsAvailablePerTicker}/${watchUniverse.length} ` +
    `agg=${snapshot.inputsAvailableAggregate}/${constituents.length} ` +
    `last_edgar=${lastQueryStr} (${bdSince != null ? `${bdSince}bd` : '—'})`;

  // gics-sector-baseline-computation.md §1.3 (Step 5) per-cycle aggregate log.
  // Sector names containing spaces (e.g. "Consumer Discretionary") are
  // underscore-tokenized so the §5.5 G2-DAEMON regex `max_z=(\S+):(\S+)` matches
  // without bleeding into the next field.
  const aggMaxSector = snapshot.maxAggregateZSector;
  const aggMaxZ = snapshot.maxAggregateZ;
  const aggMaxToken = aggMaxSector != null && aggMaxZ != null
    ? `${aggMaxSector.replace(/\s+/g, '_')}:${aggMaxZ.toFixed(2)}`
    : 'n/a:n/a';
  const aggregateLogLine =
    `[xd-aggregate] sectors_with_z=${snapshot.inputsAvailableAggregate}/11 ` +
    `floor_cleared=${snapshot.inputsAvailableAggregate}/11 ` +
    `max_z=${aggMaxToken} ` +
    `cluster_flag=${snapshot.executiveClusterDeparture ? 'true' : 'false'}`;

  return { snapshot, inputs, summaryLine, aggregateLogLine };
}

/**
 * What could break this:
 *   - G1-A4 sector wiring (s94 #4): `readSectorByTicker` reads
 *     `quantlab.gics_sector_map` via PIT-DESC LIMIT 1 BY ticker. The
 *     aggregate-sector slicing remains DORMANT (`inputs.sectors` still
 *     empty) — G2 activation blocks on OQ-G2-1 (per-sector daily departure-
 *     rate baseline-computation strategy ADR). When G2 ADR lands and the
 *     baseline approach is selected, this file populates `inputs.sectors`
 *     with the SP500 PIT constituents grouped by sector + the trailing-2y
 *     `departure_rate_s` baseline series; the composite math is already
 *     implemented + tested in A2.
 *   - `inputsAvailablePerTicker` from the composite counts rows with BOTH
 *     a CIK + a sector. With G1-A4 wiring this is now meaningful (gates
 *     on actual GICS coverage from the Wikipedia ingest). Pre-first-
 *     ingest cold start: `readSectorByTicker` returns empty map →
 *     `perTicker[].sector` is null on every row → `inputsAvailablePerTicker`
 *     is 0. The brief now uses the composer-stamped CIK-only count
 *     (`tickersWithCikCount`) for the universe-coverage line so the
 *     "0/60 with sector" cold-start does NOT poison the rendered metric
 *     (S93-28 fix mirrored to section #12 per G1-A4).
 *   - readEventsForTickersInWindow narrows to sub_item_code IN ('5.02(b)',
 *     '5.02(c)') — if the v2 ADR adds 5.02(a)/(d)/(e) to the composite,
 *     bump COMPOSITE_SUB_ITEM_CODES (and re-version the composite per E-9).
 *   - readCikByTicker is one-way (current ticker → CIK). Historical aliases
 *     stored in `former_tickers` are NOT consulted; tickers that swapped
 *     names mid-window will have a different CIK row in `executive_departures`
 *     (A1's ticker resolver writes the CURRENT ticker into the row, so
 *     historical lookup IS preserved via the `ticker` column, not via the
 *     map). The map is for the daemon's reverse-lookup-from-watch-universe
 *     path only.
 *   - The CH `executive_departures` table is ReplacingMergeTree(ingested_at).
 *     FINAL collapses re-ingest duplicates. The composite's `dedupeEvents`
 *     is defense-in-depth for the case where two rows still survive a FINAL
 *     (e.g., merge backlog).
 *   - businessDaysBetween counts weekdays only; US market holidays not
 *     accounted for. Same staleness-rough-signal posture as short-interest.
 *   - Empty watch universe / empty constituents propagate cleanly: per-ticker
 *     payload is empty; aggregate inputs are empty; composite returns a
 *     snapshot with cluster_departure = false and zero flagged rows. The
 *     daemon's anomaly-push handles the visibility.
 *   - readLatestAcceptedAt + readEventsForTickersInWindow both filter on
 *     `accepted_at`, NOT `period_of_report`, per the load-bearing E-7 lock.
 *     A refactor that swapped to period_of_report would introduce a
 *     look-ahead-leak vector (filings can be retroactively dated up to 4bd
 *     before acceptance per Sarbanes-Oxley §409 / 17 CFR 249.308).
 */
