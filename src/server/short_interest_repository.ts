/**
 * Short-interest repository — reads FINRA biweekly short-interest + SP500 PIT
 * constituents, writes daily snapshots (Phase A4).
 *
 * SPEC: docs/specs/short-interest-tracking.md §3 (component diagram),
 *       §5 (composite formulas), §6 (snapshot schema), §7 (daemon hook),
 *       §10 Phase A4 (this unit).
 *
 * Responsibility split (mirrors cross_asset_signals_repository / sector_rotation_repository):
 *   - Pure composite logic lives in src/server/short_interest.ts.
 *   - This repository is the I/O boundary: pulls the latest FINRA rows,
 *     the t-6 biweekly row, the per-ticker shares_short baseline, the
 *     SPY-500 PIT constituent panel, and the aggregate baseline; feeds
 *     the composite; writes the snapshot to quantlab.short_interest_snapshots.
 *
 * Path A4-β semantics (autonomous resolution; see HANDOFF s90 + SPEC §5.1
 *   "v1 implementation note"):
 *
 *   The SPEC formulates per-stock signals on SIR = shares_short /
 *   shares_outstanding. FINRA's biweekly feed does NOT publish
 *   shares_outstanding. Adding a yfinance shares_outstanding ingest would
 *   introduce a live yfinance dependency at daemon-eval time AND an
 *   additional settlement-date asymmetry (yfinance publishes shares_outstanding
 *   as a single CURRENT value, not as a settlement-date-aware historical series).
 *
 *   Path A4-β instead operates on shares_short ROC directly. The SIR ratio is
 *   approximately equal to shares_short up to a slowly-varying shares_outstanding
 *   denominator — for SPY-500-scale tickers, the buyback/issuance rate over
 *   a 3-month window is well below the SHORT_RAMP_ROC_THRESHOLD (50%) and
 *   SHORT_CAPITULATION_ROC_THRESHOLD (-40%) scales. Per Diether-Lee-Werner
 *   2009 §3, the load-bearing signal is the RATE OF CHANGE, and ROC of
 *   shares_short equals ROC of SIR when shares_outstanding is constant
 *   (approximately equal when it varies slowly).
 *
 *   Implementation: this repository feeds `sharesShortT` values into the A2
 *   composite's `sharesShortT` slot AND feeds `sharesOutstandingT = 1` into
 *   the `sharesOutstandingT` slot. `computeSIR(sharesShortT, 1) = sharesShortT`
 *   reinterprets the SIR field as raw shares_short. The composite's ROC, D2C,
 *   flag-firing, and aggregate-z math are unchanged — they are dimensionally
 *   agnostic. The A5 brief renderer (next slice) will surface raw shares_short
 *   + change_pct rather than SIR.
 *
 *   Composite version remains short_interest_v1; the SPEC document is amended
 *   in this commit with the Path A4-β implementation note.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';
import {
  evaluateShortInterestComposite,
  MIN_Z_BASELINE,
  SHORT_INTEREST_COMPOSITE_VERSION,
  type ShortInterestInputs,
  type ShortInterestSnapshot,
} from './short_interest.js';

/** FINRA publication lag — biweekly reports publish ~8 business days after
 *  settlement. Used for S-SI-5 settlement-date-aware lag check + asOf gate. */
export const PUBLICATION_LAG_BUSINESS_DAYS = 8;

/** S-SI-10 baseline window. 2y of calendar days; biweekly cadence yields ~52
 *  prints (≥ MIN_Z_BASELINE = 30). */
export const BASELINE_CALENDAR_DAYS = 730;

/** S-SI-3 ROC window: 6 biweekly reports back ~= 3 months. */
export const ROC_REPORTS_BACK = 6;

/** Pull a small window of distinct settlement_dates to find the t-6 anchor.
 *  ROC_REPORTS_BACK + 1 = 7 covers the latest + 6 prior reports. */
export const DISTINCT_SETTLEMENT_LOOKBACK = ROC_REPORTS_BACK + 1;

export interface ShortInterestRepositoryOptions {
  ch?: ClickHouseClient;
  shortInterestTable?: string;
  sp500ConstituentsTable?: string;
  candlesTable?: string;
  snapshotsTable?: string;
}

export interface ShortInterestDaemonResult {
  snapshot: ShortInterestSnapshot;
  inputs: ShortInterestInputs;
  summaryLine: string;
}

/** A row from quantlab.short_interest as consumed internally. */
export interface FinraRow {
  symbol: string;
  cusip: string;
  settlementDate: string; // YYYY-MM-DD
  publishedAt: string;    // YYYY-MM-DD
  sharesShort: number;
  prevSharesShort: number | null;
  adv20d: number | null;
}

interface RawFinraRow {
  symbol: string;
  cusip: string | null;
  settlement_date: string;
  published_at: string;
  shares_short: string | number;
  prev_shares_short: string | number | null;
  adv_20d: string | number | null;
}

interface RawBaselineRow {
  symbol: string;
  shares_short: string | number;
}

interface RawAggregateRow {
  settlement_date: string;
  agg: string | number;
}

interface RawDistinctRow {
  settlement_date: string;
}

interface RawConstituentRow {
  ticker: string;
}

interface RawLastPubRow {
  last: string | null;
}

interface RawSnapshotRow {
  snapshot_date: string;
  computed_at_ms: string | number;
  last_finra_publication: string | null;
  bd_since_publication: number | null;
  aggregate_sir: number | null;
  aggregate_z: number | null;
  aggregate_baseline_size: number | string;
  sentiment_short_extreme: number | string;
  per_ticker_json: string;
  inputs_available_aggregate: number | string;
  inputs_available_per_ticker: number | string;
  composite_version: string;
}

export class ShortInterestRepository {
  private readonly ch: ClickHouseClient;
  readonly shortInterestTable: string;
  readonly sp500ConstituentsTable: string;
  readonly candlesTable: string;
  readonly snapshotsTable: string;

  constructor(opts: ShortInterestRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.shortInterestTable = opts.shortInterestTable ?? 'quantlab.short_interest';
    this.sp500ConstituentsTable = opts.sp500ConstituentsTable ?? 'quantlab.sp500_constituents';
    this.candlesTable = opts.candlesTable ?? 'quantlab.candles';
    this.snapshotsTable = opts.snapshotsTable ?? 'quantlab.short_interest_snapshots';
  }

  /**
   * Latest FINRA published_at ≤ asOf — used for the `last_finra_publication`
   * + `bd_since_publication` staleness indicators in the snapshot. Returns
   * null when no FINRA data is present yet (table empty / pre-first-ingest).
   */
  async readLatestPublication(asOf: Date): Promise<Date | null> {
    const asOfStr = toIsoDate(asOf);
    const q = await this.ch.query({
      query: `
        SELECT max(published_at) AS last
        FROM ${this.shortInterestTable} FINAL
        WHERE published_at <= {asOf:Date}
      `,
      query_params: { asOf: asOfStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawLastPubRow>();
    const last = rows[0]?.last;
    if (last == null) return null;
    // CH returns '1970-01-01' when no rows match max(); guard against it.
    const d = parseIsoDate(String(last).slice(0, 10));
    if (d == null) return null;
    if (d.getUTCFullYear() < 2000) return null;
    return d;
  }

  /**
   * Read distinct settlement_dates DESC for the latest N. The 0th element is
   * the current settlement; the (ROC_REPORTS_BACK)th is the t-6 anchor. Used
   * to align the per-ticker t-6 read for the ROC computation.
   */
  async readDistinctSettlementDates(
    asOf: Date,
    n: number = DISTINCT_SETTLEMENT_LOOKBACK,
  ): Promise<string[]> {
    const asOfStr = toIsoDate(asOf);
    const q = await this.ch.query({
      query: `
        SELECT toString(settlement_date) AS settlement_date
        FROM (
          SELECT settlement_date
          FROM ${this.shortInterestTable} FINAL
          WHERE published_at <= {asOf:Date}
          GROUP BY settlement_date
          ORDER BY settlement_date DESC
          LIMIT {n:UInt32}
        )
      `,
      query_params: { asOf: asOfStr, n },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawDistinctRow>();
    return rows.map(r => String(r.settlement_date).slice(0, 10));
  }

  /**
   * Read the latest FINRA row per symbol whose published_at ≤ asOf
   * (S-SI-5 settlement-date-aware lag). Subquery-around-FINAL (a52c964
   * regression class).
   */
  async readLatestFinraRowsAsOf(
    asOf: Date,
    symbols: readonly string[],
  ): Promise<Map<string, FinraRow>> {
    if (symbols.length === 0) return new Map();
    const asOfStr = toIsoDate(asOf);
    const q = await this.ch.query({
      query: `
        SELECT
          symbol,
          argMax(cusip, settlement_date) AS cusip,
          toString(max(settlement_date)) AS settlement_date,
          toString(argMax(published_at, settlement_date)) AS published_at,
          argMax(shares_short, settlement_date) AS shares_short,
          argMax(prev_shares_short, settlement_date) AS prev_shares_short,
          argMax(adv_20d, settlement_date) AS adv_20d
        FROM (
          SELECT
            symbol, cusip, settlement_date, published_at,
            shares_short, prev_shares_short, adv_20d
          FROM ${this.shortInterestTable} FINAL
          WHERE published_at <= {asOf:Date}
            AND symbol IN ({syms:Array(String)})
        )
        GROUP BY symbol
      `,
      query_params: { asOf: asOfStr, syms: [...symbols] },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawFinraRow>();
    return parseFinraRows(rows);
  }

  /**
   * Read FINRA rows for a fixed settlement_date (used to pin the t-6 anchor
   * once readDistinctSettlementDates identifies the date). NOT filtered by
   * published_at because the caller has already enforced the asOf lag.
   */
  async readFinraRowsAtDate(
    settlementDate: string,
    symbols: readonly string[],
  ): Promise<Map<string, FinraRow>> {
    if (symbols.length === 0) return new Map();
    const q = await this.ch.query({
      query: `
        SELECT
          symbol,
          argMax(cusip, ingested_at) AS cusip,
          toString(settlement_date) AS settlement_date,
          toString(argMax(published_at, ingested_at)) AS published_at,
          argMax(shares_short, ingested_at) AS shares_short,
          argMax(prev_shares_short, ingested_at) AS prev_shares_short,
          argMax(adv_20d, ingested_at) AS adv_20d
        FROM (
          SELECT
            symbol, cusip, settlement_date, published_at,
            shares_short, prev_shares_short, adv_20d, ingested_at
          FROM ${this.shortInterestTable} FINAL
          WHERE settlement_date = {dt:Date}
            AND symbol IN ({syms:Array(String)})
        )
        GROUP BY symbol, settlement_date
      `,
      query_params: { dt: settlementDate, syms: [...symbols] },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawFinraRow>();
    return parseFinraRows(rows);
  }

  /**
   * Read the trailing per-ticker shares_short baseline within (asOf - days, asOf].
   * Returns a Map of symbol → sorted-ASC values; the composite consumes the
   * derived median + sample stddev for the `prior_high_base` qualifier on
   * `short_capitulation` (S-SI-3 + SPEC §11 OQ#2 → 2y per-ticker).
   */
  async readPerTickerShortShortBaseline(
    asOf: Date,
    symbols: readonly string[],
    days: number = BASELINE_CALENDAR_DAYS,
  ): Promise<Map<string, number[]>> {
    if (symbols.length === 0) return new Map();
    const asOfStr = toIsoDate(asOf);
    const startStr = toIsoDate(new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000));
    const q = await this.ch.query({
      query: `
        SELECT symbol, shares_short
        FROM (
          SELECT symbol, settlement_date, shares_short
          FROM ${this.shortInterestTable} FINAL
          WHERE settlement_date >= {start:Date}
            AND settlement_date <= {asOf:Date}
            AND symbol IN ({syms:Array(String)})
          ORDER BY symbol, settlement_date ASC
        )
      `,
      query_params: { start: startStr, asOf: asOfStr, syms: [...symbols] },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawBaselineRow>();
    const out = new Map<string, number[]>();
    for (const r of rows) {
      const v = typeof r.shares_short === 'string' ? parseFloat(r.shares_short) : r.shares_short;
      if (!Number.isFinite(v)) continue;
      const arr = out.get(r.symbol) ?? [];
      arr.push(v);
      out.set(r.symbol, arr);
    }
    return out;
  }

  /**
   * Read the SPY-500 PIT constituent panel as-of asOf. Per S-SI-4: the
   * constituent list AT THE SNAPSHOT DATE, not today's. Falls back to
   * the latest available effective_date when no row is dated ≤ asOf
   * (e.g., the table was just ingested today; effective_date = today).
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
   * Symbol form (FINRA) = token_address stripped of '_USD' suffix
   * (e.g., 'AAPL_USD' → 'AAPL'). Filters to addresses that match the
   * mid-cap convention (^[A-Z]{1,5}_USD$) and have current data.
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
   * Aggregate baseline = mean(shares_short across constituents) per
   * historical settlement_date over trailing 2y. Per Path A4-β: aggregate
   * is mean shares_short (equal-weight per SPEC §11 OQ#3), z-scored against
   * its own 2y baseline (~52 biweekly prints).
   *
   * Drift in the SPY 500 constituent set + total shares_outstanding over 2y
   * is captured in the baseline naturally — this is the v1 simplification
   * (no per-historical-date PIT reconstruction).
   */
  async readAggregateBaseline(
    asOf: Date,
    constituents: readonly string[],
    days: number = BASELINE_CALENDAR_DAYS,
  ): Promise<number[]> {
    if (constituents.length === 0) return [];
    const asOfStr = toIsoDate(asOf);
    const startStr = toIsoDate(new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000));
    const q = await this.ch.query({
      query: `
        SELECT toString(settlement_date) AS settlement_date, avg(shares_short) AS agg
        FROM (
          SELECT settlement_date, symbol, shares_short
          FROM ${this.shortInterestTable} FINAL
          WHERE settlement_date >= {start:Date}
            AND settlement_date <= {asOf:Date}
            AND symbol IN ({syms:Array(String)})
        )
        GROUP BY settlement_date
        ORDER BY settlement_date ASC
      `,
      query_params: { start: startStr, asOf: asOfStr, syms: [...constituents] },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawAggregateRow>();
    const out: number[] = [];
    for (const r of rows) {
      const v = typeof r.agg === 'string' ? parseFloat(r.agg) : r.agg;
      if (Number.isFinite(v)) out.push(v);
    }
    return out;
  }

  /**
   * Compose all inputs the A2 composite needs for `asOf`. Pure-function
   * composite consumes the result; the repository does ALL I/O + windowing.
   *
   * Caller supplies the watch universe (the equity-midcap symbol list) +
   * the SPY 500 constituent list. The orchestrator helper
   * `runDaemonShortInterestEvaluation` resolves these from CH; tests inject
   * fixed lists.
   */
  async readInputsForCycle(
    asOf: Date,
    watchUniverse: readonly string[],
    constituents: readonly string[],
  ): Promise<ShortInterestInputs> {
    const [latestPub, settlementDates, perTickerLatest, perTickerBaseline, aggregateLatest, aggregateBaseline] =
      await Promise.all([
        this.readLatestPublication(asOf),
        this.readDistinctSettlementDates(asOf, DISTINCT_SETTLEMENT_LOOKBACK),
        this.readLatestFinraRowsAsOf(asOf, watchUniverse),
        this.readPerTickerShortShortBaseline(asOf, watchUniverse, BASELINE_CALENDAR_DAYS),
        this.readLatestFinraRowsAsOf(asOf, constituents),
        this.readAggregateBaseline(asOf, constituents, BASELINE_CALENDAR_DAYS),
      ]);

    // t-6 anchor: 7th element (index 6) of the DESC-ordered distinct
    // settlement_date list. Null when fewer than 7 reports have been
    // published-by-asOf (new ingest, freshly-spun-up environment).
    const t6Date = settlementDates.length > ROC_REPORTS_BACK ? settlementDates[ROC_REPORTS_BACK] : null;
    const perTickerT6: Map<string, FinraRow> = t6Date
      ? await this.readFinraRowsAtDate(t6Date, watchUniverse)
      : new Map();

    // Per-ticker inputs (Path A4-β: pass shares_short into the SIR slot
    // and sharesOutstanding=1 so computeSIR(shares_short, 1) === shares_short).
    const perTicker = watchUniverse.map(ticker => {
      const t = perTickerLatest.get(ticker);
      const t6 = perTickerT6.get(ticker);
      const baseline = perTickerBaseline.get(ticker) ?? [];
      const baselineHasFloor = baseline.length >= MIN_Z_BASELINE;
      return {
        ticker,
        cusip: t?.cusip ?? '',
        sharesShortT: t?.sharesShort ?? null,
        sharesOutstandingT: t != null ? 1 : null,
        sharesShortT6: t6?.sharesShort ?? null,
        sharesOutstandingT6: t6 != null ? 1 : null,
        adv20d: t?.adv20d ?? null,
        baseline2yMedian: baselineHasFloor ? median(baseline) : null,
        baseline2yStddev: baselineHasFloor ? sampleStddev(baseline) : null,
        baseline2ySize: baseline.length,
      };
    });

    // Aggregate inputs (Path A4-β: shares_short directly).
    const aggregatePerTickerSirs: Array<number | null> = constituents.map(t => {
      const row = aggregateLatest.get(t);
      return row?.sharesShort ?? null;
    });

    const bdSinceLastPublication = latestPub != null ? businessDaysBetween(latestPub, asOf) : null;

    return {
      asOf,
      lastFinraPublication: latestPub,
      bdSinceLastPublication,
      perTicker,
      aggregate: {
        perTickerSirs: aggregatePerTickerSirs,
        baseline2y: aggregateBaseline,
      },
    };
  }

  /** Persist one snapshot. Idempotent under ReplacingMergeTree(computed_at)
   *  on (snapshot_date) per A3 schema. */
  async writeSnapshot(snapshot: ShortInterestSnapshot): Promise<void> {
    const snapshotDate = toIsoDate(snapshot.snapshotDate);
    const computedAt = formatDateTime64(snapshot.snapshotDate);
    const lastPub = snapshot.lastFinraPublication != null
      ? toIsoDate(snapshot.lastFinraPublication)
      : null;
    // Per-ticker payload stored as JSON per A3 schema (per_ticker_json String).
    // Path A4-β: sirT / sirT6 / sirRoc fields hold shares_short values + ROC.
    const perTickerJson = JSON.stringify(snapshot.perTickerRows);
    await this.ch.insert({
      table: this.snapshotsTable,
      values: [{
        snapshot_date: snapshotDate,
        computed_at: computedAt,
        last_finra_publication: lastPub,
        bd_since_publication: snapshot.bdSincePublication,
        aggregate_sir: snapshot.aggregateSir,
        aggregate_z: snapshot.aggregateZ,
        aggregate_baseline_size: snapshot.aggregateBaselineSize,
        sentiment_short_extreme: snapshot.sentimentShortExtreme ? 1 : 0,
        per_ticker_json: perTickerJson,
        inputs_available_aggregate: snapshot.inputsAvailableAggregate,
        inputs_available_per_ticker: snapshot.inputsAvailablePerTicker,
        composite_version: snapshot.version,
      }],
      format: 'JSONEachRow',
    });
  }

  /** Read the most-recent snapshot. Used by the morning brief (A5). */
  async loadLatestSnapshot(): Promise<ShortInterestSnapshot | null> {
    const q = await this.ch.query({
      query: `
        SELECT
          toString(snapshot_date) AS snapshot_date,
          toUnixTimestamp64Milli(computed_at) AS computed_at_ms,
          toString(last_finra_publication) AS last_finra_publication,
          bd_since_publication,
          aggregate_sir, aggregate_z, aggregate_baseline_size,
          sentiment_short_extreme,
          per_ticker_json,
          inputs_available_aggregate, inputs_available_per_ticker,
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
    // CH renders NULL Date as '1970-01-01' via toString; guard it.
    let lastPub: Date | null = null;
    if (r.last_finra_publication) {
      const parsed = parseIsoDate(r.last_finra_publication.slice(0, 10));
      if (parsed != null && parsed.getUTCFullYear() >= 2000) lastPub = parsed;
    }
    let perTickerRows: ShortInterestSnapshot['perTickerRows'] = [];
    try {
      const parsed = JSON.parse(r.per_ticker_json);
      if (Array.isArray(parsed)) {
        perTickerRows = parsed as ShortInterestSnapshot['perTickerRows'];
      }
    } catch {
      // Malformed payload — degrade gracefully; the brief shows zero flagged
      // rows. The watch-out at the bottom of this file documents this.
      perTickerRows = [];
    }
    return {
      snapshotDate: new Date(Number(r.computed_at_ms)),
      lastFinraPublication: lastPub,
      bdSincePublication: r.bd_since_publication != null ? Number(r.bd_since_publication) : null,
      aggregateSir: nullableNum(r.aggregate_sir),
      aggregateZ: nullableNum(r.aggregate_z),
      aggregateBaselineSize: Number(r.aggregate_baseline_size),
      sentimentShortExtreme: Number(r.sentiment_short_extreme) === 1,
      perTickerRows,
      inputsAvailableAggregate: Number(r.inputs_available_aggregate),
      inputsAvailablePerTicker: Number(r.inputs_available_per_ticker),
      version: r.composite_version as typeof SHORT_INTEREST_COMPOSITE_VERSION,
    };
  }
}

// ───── helpers ──────────────────────────────────────────────────────────────

function parseFinraRows(rows: readonly RawFinraRow[]): Map<string, FinraRow> {
  const out = new Map<string, FinraRow>();
  for (const r of rows) {
    const sharesShort = toNum(r.shares_short);
    if (sharesShort == null || sharesShort < 0) continue;
    out.set(r.symbol, {
      symbol: r.symbol,
      cusip: r.cusip ?? '',
      settlementDate: String(r.settlement_date).slice(0, 10),
      publishedAt: String(r.published_at).slice(0, 10),
      sharesShort,
      prevSharesShort: toNum(r.prev_shares_short),
      adv20d: toNum(r.adv_20d),
    });
  }
  return out;
}

function toNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function nullableNum(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseIsoDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateTime64(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

/** Business days between [start, end] strictly (start excluded, end included).
 *  Mon-Fri only; holidays not accounted for (the brief renders biz days as a
 *  rough staleness signal, not a calendar-accurate count). */
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

/** Median of a finite numeric array. NaN when array is empty. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Sample stddev (n-1 in denominator) per AFML §1.3. NaN when n < 2. */
export function sampleStddev(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / xs.length;
  let sumSq = 0;
  for (const x of xs) {
    const d = x - mean;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / (xs.length - 1));
}

/** Module-level probe: does the snapshots table exist?
 *  Mirrors the absent-table-safe gate from cross_asset_signals_repository. */
export async function shortInterestSnapshotsTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'short_interest_snapshots'`,
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
 * Wired into scripts/daily_signal_daemon.ts as step 1h (after step 1g
 * cross-asset).
 *
 * The orchestrator resolves the equity-midcap watch universe + SPY 500 PIT
 * constituents from CH, then composes + writes a single snapshot.
 *
 * Pre-passed `watchUniverse` / `constituents` override the CH reads —
 * tests inject fixed lists; the daemon path lets the orchestrator resolve
 * them itself.
 */
export async function runDaemonShortInterestEvaluation(opts: {
  repo: ShortInterestRepository;
  asOf: Date;
  watchUniverse?: readonly string[];
  constituents?: readonly string[];
}): Promise<ShortInterestDaemonResult> {
  const watchUniverse = opts.watchUniverse ?? await opts.repo.readEquityMidcapWatchUniverse();
  const constituents = opts.constituents ?? await opts.repo.readSp500ConstituentsPIT(opts.asOf);
  const inputs = await opts.repo.readInputsForCycle(opts.asOf, watchUniverse, constituents);
  const snapshot = evaluateShortInterestComposite(inputs);
  await opts.repo.writeSnapshot(snapshot);

  const flaggedRamp = snapshot.perTickerRows.filter(r => r.shortRamp).length;
  const flaggedCap = snapshot.perTickerRows.filter(r => r.shortCapitulation).length;
  const bdSince = snapshot.bdSincePublication;
  const lastPubStr = snapshot.lastFinraPublication != null
    ? toIsoDate(snapshot.lastFinraPublication)
    : '—';
  const aggSirStr = snapshot.aggregateSir != null
    ? snapshot.aggregateSir.toExponential(2)
    : '—';
  const aggZStr = snapshot.aggregateZ != null ? snapshot.aggregateZ.toFixed(2) : '—';
  const summaryLine =
    `[short-interest] ${toIsoDate(opts.asOf)} ` +
    `agg_mean_short=${aggSirStr} z=${aggZStr} ` +
    `extreme=${snapshot.sentimentShortExtreme ? 'YES' : 'NO'} ` +
    `(baseline n=${snapshot.aggregateBaselineSize}) ` +
    `flagged=ramp:${flaggedRamp}/cap:${flaggedCap} ` +
    `universe=${snapshot.inputsAvailablePerTicker}/${watchUniverse.length} ` +
    `agg=${snapshot.inputsAvailableAggregate}/${constituents.length} ` +
    `last_finra=${lastPubStr} (${bdSince != null ? `${bdSince}bd` : '—'})`;

  return { snapshot, inputs, summaryLine };
}

/**
 * What could break this:
 *   - The Path A4-β reinterpretation passes `sharesOutstandingT = 1` into
 *     the A2 composite so `computeSIR(sharesShort, 1) = sharesShort`. A
 *     refactor of computeSIR that adds an "outstanding must be > 1" guard
 *     would break this — the A2 tests pin computeSIR's current behavior, so
 *     a refactor would have to update both layers consistently. The A4
 *     resolution lives in the SPEC's §5.1 "v1 implementation note."
 *   - readDistinctSettlementDates queries DISTINCT on settlement_date but
 *     biweekly cadence means rows come in pairs (15th + last-bd-of-month).
 *     The LIMIT 7 selects the latest 7 distinct settlements, which is the
 *     correct ~3.5-month anchor for ROC_REPORTS_BACK = 6. If FINRA changes
 *     cadence (Reg-SHO daily expansion), the t-6 anchor semantic shifts —
 *     bump the ROC_REPORTS_BACK constant accordingly.
 *   - readSp500ConstituentsPIT falls back to the latest effective_date when
 *     no row dated ≤ asOf exists. In a fresh environment the table may have
 *     only today's row, so PIT-as-of-asOf and as-of-today coincide. Not a
 *     correctness issue for v1.
 *   - readAggregateBaseline uses CURRENT constituents (not per-historical-date
 *     PIT). For SPY 500 this introduces a slow drift (turnover ~3% / year),
 *     well below the |z| > 2 threshold scale. A v2 enhancement could rebuild
 *     the baseline date-by-date using PIT constituents at each settlement —
 *     deferred until empirical evidence shows the drift matters.
 *   - The CH `short_interest` table is ReplacingMergeTree(ingested_at), so
 *     FINAL collapses re-ingest duplicates. The argMax(field, settlement_date)
 *     in readLatestFinraRowsAsOf then collapses across settlements per symbol.
 *     A test pins the subquery-around-FINAL shape.
 *   - businessDaysBetween counts weekdays only — US market holidays not
 *     accounted for. The brief renders bd_since_publication as a rough
 *     staleness signal, not a calendar-accurate count. A 9bd render when
 *     the calendar count is 8bd (holiday in window) is acceptable.
 *   - Empty watch universe or empty constituents propagate cleanly: per-ticker
 *     payload is empty array; aggregate inputs are empty; composite returns
 *     a snapshot with null aggregates and zero flagged rows. The daemon's
 *     anomaly-push handles the visibility.
 */
