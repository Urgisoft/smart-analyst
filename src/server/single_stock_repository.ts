/**
 * Single-stock repository — read-only CH I/O for the single-stock scorecard.
 *
 * The I/O boundary for `single_stock_dashboard.ts`. Three read methods, one
 * per CH-backed dimension; each is independently table-exists-guarded so a
 * missing source returns an honest empty block rather than throwing (ADR-044
 * UI correctness — no 500s).
 *
 * Sources (all read-only; this repository writes NOTHING):
 *   - quantlab.equity_daily_polygon  (ticker, date, open, high, low, close, volume)
 *   - quantlab.insider_trades        (issuer_ticker, transaction_code P/S, dollar_amount, shares, accepted_at)
 *   - quantlab.short_interest        (symbol, settlement_date, shares_short, prev_shares_short, adv_20d, published_at)
 *   - quantlab.schedule_13d_g_filings(issuer_ticker, form_type, is_amendment, accepted_at)
 *   - quantlab.macro_regimes         (trade_date, classifier_version, regime)
 *   - quantlab.gics_sector_map       (ticker, gics_sector, gics_sub_industry, snapshot_date)
 *
 * NO ALPHA CLAIM (ADR-056). These are raw aggregations for a human reading a
 * scorecard, not signals.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';
import { readGicsSectorByTicker } from './gics_sector_repository_helper.js';

// ── Public block types ──────────────────────────────────────────────────────

export interface TechnicalsBlock {
  available: boolean;
  note: string | null;
  lastClose: number | null;
  lastDate: string | null;
  /** Trailing simple moving averages (approx — over available daily closes). */
  sma50: number | null;
  sma200: number | null;
  high52w: number | null;
  low52w: number | null;
  /** Position within the 52-wk range, 0..1 (close-low)/(high-low). */
  pctOf52wRange: number | null;
  mom1mPct: number | null; // 21-trading-day return, %
  mom1yPct: number | null; // ~252-trading-day return, %
  /** How many daily rows backed this block (transparency on approximation). */
  rowsUsed: number;
}

export interface InsiderNet {
  buyDollars: number;
  sellDollars: number;
  netDollars: number;
  buyCount: number;
  sellCount: number;
}

export interface ShortInterestLatest {
  settlementDate: string;
  sharesShort: number;
  prevSharesShort: number | null;
  changePct: number | null;
  daysToCover: number | null; // shares_short / adv_20d
}

export interface ActivistFilings {
  total: number;
  byForm: Array<{ formType: string; count: number }>;
}

export interface PositioningBlock {
  available: boolean;
  note: string | null;
  insider: InsiderNet | null;
  shortInterest: ShortInterestLatest | null;
  activist: ActivistFilings | null;
}

export interface MacroFitBlock {
  available: boolean;
  note: string | null;
  regime: string | null;
  regimeDate: string | null;
  classifierVersion: string | null;
  sector: string | null;
  subIndustry: string | null;
}

// ── Lookback constants ──────────────────────────────────────────────────────

const SMA50_DAYS = 50;
const SMA200_DAYS = 200;
const TRADING_DAYS_1Y = 252;
const TRADING_DAYS_1M = 21;
const WEEKS52_CALENDAR_DAYS = 372; // ~52wk + buffer for the 52-wk hi/lo window
const INSIDER_LOOKBACK_DAYS = 365;
const PREFERRED_CLASSIFIER = 'phase1_v3'; // GAP-8: v3 is the source-of-truth classifier

export class SingleStockRepository {
  private readonly ch: ClickHouseClient;
  constructor(opts: { ch?: ClickHouseClient } = {}) {
    this.ch = opts.ch ?? getClickHouse();
  }

  // ── Technicals ───────────────────────────────────────────────────────────

  /**
   * Pull up to 1y of daily closes for `ticker` and derive last close, ~50/200d
   * SMAs, 52-wk hi/lo, and 1-mo / 1-yr momentum. SMAs are approximate: averaged
   * over the most recent N available closes (N may be < 50/200 for short-history
   * names — `rowsUsed` exposes that). Table-absent → honest empty block.
   */
  async readTechnicals(ticker: string, asOf: Date): Promise<TechnicalsBlock> {
    if (!(await tableExists(this.ch, 'equity_daily_polygon'))) {
      return technicalsEmpty('quantlab.equity_daily_polygon is absent — run the Polygon ingest.');
    }
    const asOfStr = asOf.toISOString().slice(0, 10);
    const startStr = new Date(asOf.getTime() - WEEKS52_CALENDAR_DAYS * 86_400_000)
      .toISOString().slice(0, 10);
    // Subquery-around-FINAL: FINAL + WHERE in the inner SELECT, the toString
    // alias outside (a52c964 regression class). Ordered ASC for momentum.
    const q = await this.ch.query({
      query: `
        SELECT toString(date) AS date, close
        FROM (
          SELECT date, close
          FROM quantlab.equity_daily_polygon FINAL
          WHERE ticker = {ticker:String}
            AND date >= {start:Date}
            AND date <= {asOf:Date}
          ORDER BY date ASC
        )
      `,
      query_params: { ticker, start: startStr, asOf: asOfStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<{ date: string; close: string | number }>();
    const series = rows
      .map(r => ({ date: r.date, close: numOrNull(r.close) }))
      .filter((r): r is { date: string; close: number } => r.close != null && r.close > 0);
    if (series.length === 0) {
      return technicalsEmpty(`No Polygon rows for ${ticker} in the trailing 52wk window.`);
    }
    const closes = series.map(s => s.close);
    const lastClose = closes[closes.length - 1];
    const lastDate = series[series.length - 1].date;
    const sma50 = tailMean(closes, SMA50_DAYS);
    const sma200 = tailMean(closes, SMA200_DAYS);
    const high52w = Math.max(...closes);
    const low52w = Math.min(...closes);
    const range = high52w - low52w;
    const pctOf52wRange = range > 0 ? (lastClose - low52w) / range : null;
    return {
      available: true,
      note: null,
      lastClose,
      lastDate,
      sma50,
      sma200,
      high52w,
      low52w,
      pctOf52wRange,
      mom1mPct: returnPct(closes, TRADING_DAYS_1M),
      mom1yPct: returnPct(closes, TRADING_DAYS_1Y),
      rowsUsed: closes.length,
    };
  }

  // ── Positioning ────────────────────────────────────────────────────────────

  /**
   * Trailing-365d insider net (P vs S, by dollar_amount) + latest short
   * interest + activist-filing counts. Each sub-source is individually
   * table-guarded; the block is `available` if ANY sub-source has data.
   */
  async readPositioning(ticker: string, asOf: Date): Promise<PositioningBlock> {
    const [insider, shortInterest, activist] = await Promise.all([
      this.readInsiderNet(ticker, asOf),
      this.readShortInterest(ticker, asOf),
      this.readActivist(ticker, asOf),
    ]);
    const available = insider != null || shortInterest != null || activist != null;
    return {
      available,
      note: available
        ? null
        : 'No positioning data — EDGAR insider / FINRA short-interest / 13D-G ingests have not run for this ticker.',
      insider,
      shortInterest,
      activist,
    };
  }

  private async readInsiderNet(ticker: string, asOf: Date): Promise<InsiderNet | null> {
    if (!(await tableExists(this.ch, 'insider_trades'))) return null;
    const asOfStr = toIsoDateTime(asOf);
    const startStr = toIsoDateTime(new Date(asOf.getTime() - INSIDER_LOOKBACK_DAYS * 86_400_000));
    const q = await this.ch.query({
      query: `
        SELECT
          sumIf(dollar_amount, transaction_code = 'P') AS buy_dollars,
          sumIf(dollar_amount, transaction_code = 'S') AS sell_dollars,
          countIf(transaction_code = 'P') AS buy_count,
          countIf(transaction_code = 'S') AS sell_count
        FROM (
          SELECT transaction_code, dollar_amount
          FROM quantlab.insider_trades FINAL
          WHERE issuer_ticker = {ticker:String}
            AND transaction_code IN ('P', 'S')
            AND accepted_at >= {start:DateTime}
            AND accepted_at <= {asOf:DateTime}
        )
      `,
      query_params: { ticker, start: startStr, asOf: asOfStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<{
      buy_dollars: string | number; sell_dollars: string | number;
      buy_count: string | number; sell_count: string | number;
    }>();
    if (rows.length === 0) return null;
    const r = rows[0];
    const buyDollars = numOrZero(r.buy_dollars);
    const sellDollars = numOrZero(r.sell_dollars);
    const buyCount = Math.round(numOrZero(r.buy_count));
    const sellCount = Math.round(numOrZero(r.sell_count));
    if (buyCount === 0 && sellCount === 0) return null; // no rows for this ticker
    return {
      buyDollars,
      sellDollars,
      netDollars: buyDollars - sellDollars,
      buyCount,
      sellCount,
    };
  }

  private async readShortInterest(ticker: string, asOf: Date): Promise<ShortInterestLatest | null> {
    if (!(await tableExists(this.ch, 'short_interest'))) return null;
    const asOfStr = asOf.toISOString().slice(0, 10);
    // argMax-in-subquery with settlement_date aliased to `sd` to dodge the
    // CH 24.8 ILLEGAL_AGGREGATION landmine (max() + argMax() co-nesting) —
    // same fix as short_interest_repository.readLatestFinraRowsAsOf.
    const q = await this.ch.query({
      query: `
        SELECT
          toString(sd_max) AS settlement_date,
          shares_short,
          prev_shares_short,
          adv_20d
        FROM (
          SELECT
            max(sd) AS sd_max,
            argMax(shares_short, sd) AS shares_short,
            argMax(prev_shares_short, sd) AS prev_shares_short,
            argMax(adv_20d, sd) AS adv_20d
          FROM (
            SELECT settlement_date AS sd, shares_short, prev_shares_short, adv_20d
            FROM quantlab.short_interest FINAL
            WHERE symbol = {ticker:String}
              AND published_at <= {asOf:Date}
          )
        )
      `,
      query_params: { ticker, asOf: asOfStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<{
      settlement_date: string;
      shares_short: string | number;
      prev_shares_short: string | number | null;
      adv_20d: string | number | null;
    }>();
    if (rows.length === 0) return null;
    const r = rows[0];
    const sharesShort = numOrNull(r.shares_short);
    // CH returns the aggregate row even with zero matches → sd_max would be the
    // CH Date epoch '1970-01-01' and shares_short 0. Treat that as "no data".
    if (sharesShort == null || !r.settlement_date || r.settlement_date < '1990-01-01') {
      return null;
    }
    const prev = numOrNull(r.prev_shares_short);
    const adv = numOrNull(r.adv_20d);
    return {
      settlementDate: r.settlement_date,
      sharesShort,
      prevSharesShort: prev,
      changePct: prev != null && prev > 0 ? ((sharesShort - prev) / prev) * 100 : null,
      daysToCover: adv != null && adv > 0 ? sharesShort / adv : null,
    };
  }

  private async readActivist(ticker: string, asOf: Date): Promise<ActivistFilings | null> {
    if (!(await tableExists(this.ch, 'schedule_13d_g_filings'))) return null;
    const asOfStr = toIsoDateTime(asOf);
    const q = await this.ch.query({
      query: `
        SELECT form_type, count() AS n
        FROM (
          SELECT form_type
          FROM quantlab.schedule_13d_g_filings FINAL
          WHERE issuer_ticker = {ticker:String}
            AND accepted_at <= {asOf:DateTime}
        )
        GROUP BY form_type
        ORDER BY n DESC
      `,
      query_params: { ticker, asOf: asOfStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<{ form_type: string; n: string | number }>();
    const byForm = rows
      .map(r => ({ formType: r.form_type, count: Math.round(numOrZero(r.n)) }))
      .filter(r => r.formType && r.count > 0);
    if (byForm.length === 0) return null;
    return { total: byForm.reduce((a, b) => a + b.count, 0), byForm };
  }

  // ── Macro fit ────────────────────────────────────────────────────────────

  /**
   * Latest macro regime (phase1_v3 preferred) + the ticker's GICS sector.
   * Regime and sector are independent; the block is `available` if either is
   * present, so a ticker outside the SP500 GICS map still shows the regime.
   */
  async readMacroFit(ticker: string, asOf: Date): Promise<MacroFitBlock> {
    const [regime, sector] = await Promise.all([
      this.readLatestRegime(asOf),
      this.readSector(ticker, asOf),
    ]);
    const available = regime != null || sector != null;
    return {
      available,
      note: available ? null : 'Macro regime + GICS sector both unavailable.',
      regime: regime?.regime ?? null,
      regimeDate: regime?.date ?? null,
      classifierVersion: regime?.classifierVersion ?? null,
      sector: sector?.sector ?? null,
      subIndustry: sector?.subIndustry ?? null,
    };
  }

  private async readLatestRegime(
    asOf: Date,
  ): Promise<{ regime: string; date: string; classifierVersion: string } | null> {
    if (!(await tableExists(this.ch, 'macro_regimes'))) return null;
    const asOfStr = asOf.toISOString().slice(0, 10);
    const q = await this.ch.query({
      query: `
        SELECT toString(trade_date) AS trade_date, regime, classifier_version
        FROM (
          SELECT trade_date, regime, classifier_version
          FROM quantlab.macro_regimes FINAL
          WHERE classifier_version = {ver:String}
            AND trade_date <= {asOf:Date}
          ORDER BY trade_date DESC
          LIMIT 1
        )
      `,
      query_params: { ver: PREFERRED_CLASSIFIER, asOf: asOfStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<{ trade_date: string; regime: string; classifier_version: string }>();
    if (rows.length === 0 || !rows[0].regime) return null;
    return {
      regime: rows[0].regime,
      date: rows[0].trade_date,
      classifierVersion: rows[0].classifier_version,
    };
  }

  private async readSector(
    ticker: string,
    asOf: Date,
  ): Promise<{ sector: string; subIndustry: string } | null> {
    if (!(await tableExists(this.ch, 'gics_sector_map'))) return null;
    const map = await readGicsSectorByTicker(this.ch, 'quantlab.gics_sector_map', asOf, [ticker]);
    return map.get(ticker) ?? null;
  }
}

// ── Empty-block helpers ─────────────────────────────────────────────────────

function technicalsEmpty(note: string): TechnicalsBlock {
  return {
    available: false, note,
    lastClose: null, lastDate: null, sma50: null, sma200: null,
    high52w: null, low52w: null, pctOf52wRange: null,
    mom1mPct: null, mom1yPct: null, rowsUsed: 0,
  };
}

// ── Pure math helpers ───────────────────────────────────────────────────────

/** Mean of the last `n` elements (fewer if the series is shorter). null on empty. */
export function tailMean(values: number[], n: number): number | null {
  if (values.length === 0) return null;
  const tail = values.slice(Math.max(0, values.length - n));
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

/**
 * Percent return over `lookbackBars` trading days: (last / prior - 1) * 100,
 * where `prior` is the close `lookbackBars` rows back. null when the series is
 * too short or the prior close is non-positive.
 */
export function returnPct(closes: number[], lookbackBars: number): number | null {
  if (closes.length <= lookbackBars) return null;
  const last = closes[closes.length - 1];
  const prior = closes[closes.length - 1 - lookbackBars];
  if (!Number.isFinite(prior) || prior <= 0) return null;
  return (last / prior - 1) * 100;
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}
function numOrZero(v: unknown): number {
  const n = numOrNull(v);
  return n == null ? 0 : n;
}

/** CH DateTime wire format: 'YYYY-MM-DD HH:MM:SS'. */
function toIsoDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Probe whether a quantlab table exists. Mirrors the
 * cyclePositionSnapshotsTableExists idiom — any CH read failure resolves to
 * "absent", routing the caller to the empty-state path. The caller decides
 * what an absent table means for its block.
 */
export async function tableExists(
  ch: ClickHouseClient,
  name: string,
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = {name:String}`,
      query_params: { name },
      format: 'JSONEachRow',
    });
    const [{ n }] = await r.json<{ n: string | number }>();
    return Number(n) > 0;
  } catch {
    return false;
  }
}

/**
 * What could break this:
 *   - SMAs are approximate (tail-mean over available closes, not a strict
 *     50/200-trading-day window anchored to calendar). For a full-history
 *     liquid name the difference is negligible; `rowsUsed` surfaces the
 *     approximation so the panel can show "n closes" honestly.
 *   - Momentum uses trading-day OFFSETS (21 / 252 rows back), not calendar
 *     dates. Gaps (halts, holidays) shift the reference by a few days — fine
 *     for a decision-support readout, NOT for a backtest.
 *   - The short-interest argMax-subquery aliases settlement_date → `sd` to
 *     avoid the CH 24.8 ILLEGAL_AGGREGATION co-nesting bug (Cycle 41). A
 *     refactor that drops the alias would re-introduce the crash.
 *   - macro_regimes is read at classifier_version = 'phase1_v3' (GAP-8: v3 is
 *     the source-of-truth). If only older versions exist, the regime block is
 *     empty (honest), not wrong.
 *   - dollar_amount on insider_trades can be 0 for filings that omit price;
 *     net is still meaningful as a count + dollar aggregate, but a ticker with
 *     only price-less filings shows $0 net with non-zero counts. The panel
 *     renders counts alongside dollars so this is legible.
 */
