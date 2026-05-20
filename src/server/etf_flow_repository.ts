/**
 * ETF-flow repository — reads the densified shares-outstanding panel for the
 * v1 21-ETF universe, assembles per-ETF 21-day windows + trailing 1y daily
 * baselines, composes inputs for the A2 composite, writes daily snapshots
 * (Phase A4).
 *
 * SPEC: docs/specs/etf-flow-monitoring.md §3 (component diagram), §5
 *       (composite formulas), §6 (snapshot schema), §7 (daemon hook),
 *       §10 Phase A4 (this unit).
 *
 * Responsibility split (mirrors executive_departure_repository.ts):
 *   - Pure composite logic lives in src/server/etf_flow.ts (A2 — pinned).
 *   - This repository is the I/O boundary: pulls the trailing ~400-calendar-
 *     day shares + close panel per ETF from `quantlab.etf_shares_outstanding`,
 *     applies defensive carry-forward across any business-day gaps (the A1
 *     ingest densifies, but the repository belt-and-suspenders the panel for
 *     robustness against partial-ingest days), assembles exactly 21 elements
 *     per ETF for the current-snapshot window, slides the same construction
 *     across the trailing year to populate the z-score baselines, and writes
 *     the snapshot to quantlab.etf_flow_snapshots.
 *
 * Why a defensive carry-forward at this layer when the ingest already
 * densifies (scripts/etf_flow_ingest.py build_panel L274-):
 *   The ingest's forward-fill operates within a single run's calendar window.
 *   A partial-failure ingest run (T-EFI-8 non-aborting) may leave a date gap
 *   for one ticker. Carry-forward in the repository keeps the A2 composite's
 *   21-element panel invariant intact even when the source table has gaps —
 *   the operator sees the staleness via `bdSinceShareUpdate`, not via a
 *   composite throw on a 19-element panel. Same defensive posture as
 *   short_interest_repository's t-6 anchor fallback.
 *
 * `bdSinceShareUpdate` semantics (v1):
 *   Computed as `businessDaysBetween(max(date) for ticker, asOf)`. The
 *   densified panel obscures the distinction between "yfinance published a
 *   new shares-outstanding value" and "the ingest forward-filled the prior
 *   value." For v1 this is an ingest-staleness proxy: bd=0 when the daemon
 *   ran today and the source table has a row dated today; bd=N when no rows
 *   exist after asOf-N. The composite's F-CADENCE staleness flag fires on
 *   bd>3 — adequate for the operator-visible "data is stale" signal. A v2
 *   enhancement that tracked raw-vs-carry-forward at ingest time (adds an
 *   `is_carry_forward UInt8` column to etf_shares_outstanding) would refine
 *   this to per-(ticker, raw-update-day) precision.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';
import {
  computeFlowDollar20bd,
  computeFlowPctAum,
  computeReturn20bd,
  ETF_FLOW_COMPOSITE_VERSION,
  ETF_UNIVERSE,
  evaluateEtfFlowComposite,
  FLOW_WINDOW_BD,
  type EtfFlowFlaggedEtf,
  type EtfFlowInputs,
  type EtfFlowPerEtfInput,
  type EtfFlowPerEtfRow,
  type EtfFlowSnapshot,
} from './etf_flow.js';

/** Baseline target = 1y of trailing daily prints (per F-2). The composite
 *  applies MIN_Z_BASELINE = 30 internally; populating the full 252 is the
 *  steady-state target. */
export const BASELINE_TARGET_BUSINESS_DAYS = 252;

/** Calendar-day read window: covers BASELINE_TARGET_BUSINESS_DAYS + FLOW_WINDOW_BD
 *  + a generous weekend/holiday buffer. 500cd ≈ 360bd, comfortably covering
 *  252 + 20 + warmup. */
export const READ_WINDOW_CALENDAR_DAYS = 500;

/** Sentinel `bdSinceShareUpdate` for cold-start tickers (no rows at all in the
 *  trailing read window). Finite + clearly out-of-band so the F-CADENCE > 3
 *  staleness flag trips deterministically + the summary line renders a
 *  readable scalar. */
export const COLD_START_BD_SENTINEL = 9999;

export interface EtfFlowRepositoryOptions {
  ch?: ClickHouseClient;
  sourceTable?: string;
  snapshotsTable?: string;
}

export interface EtfFlowDaemonResult {
  snapshot: EtfFlowSnapshot;
  inputs: EtfFlowInputs;
  summaryLine: string;
}

interface RawSharesRow {
  ticker: string;
  date: string;       // YYYY-MM-DD
  shares: string | number;
  close: string | number;
}

interface RawLastIngestRow {
  last: string | null;
}

interface RawMaxDateRow {
  ticker: string;
  max_date: string;
}

interface RawSnapshotRow {
  snapshot_date: string;
  computed_at_ms: string | number;
  last_yfinance_query_at: string | null;
  bd_since_last_share_update: number | null;
  sector_flow_dispersion: number | null;
  aggregate_risk_on_flow: number | null;
  aggregate_flow_stress_flag: number | string;
  flagged_etfs_json: string;
  per_etf_json: string;
  aggregate_json: string;
  inputs_available_aggregate_sector: number | string;
  inputs_available_aggregate_broad: number | string;
  inputs_available_per_etf: number | string;
  composite_version: string;
}

export class EtfFlowRepository {
  private readonly ch: ClickHouseClient;
  readonly sourceTable: string;
  readonly snapshotsTable: string;

  constructor(opts: EtfFlowRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.sourceTable = opts.sourceTable ?? 'quantlab.etf_shares_outstanding';
    this.snapshotsTable = opts.snapshotsTable ?? 'quantlab.etf_flow_snapshots';
  }

  /**
   * Latest yfinance ingest wall-clock ≤ asOf — sourced from
   * `etf_shares_outstanding.ingested_at`. Returns null when table empty
   * (pre-first-ingest). Subquery-around-FINAL.
   */
  async readLatestYfinanceQueryAt(asOf: Date): Promise<Date | null> {
    const asOfStr = toIsoDateTime(asOf);
    const q = await this.ch.query({
      query: `
        SELECT toString(max(ingested_at)) AS last
        FROM (
          SELECT ingested_at
          FROM ${this.sourceTable} FINAL
          WHERE ingested_at <= {asOf:DateTime}
        )
      `,
      query_params: { asOf: asOfStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawLastIngestRow>();
    const last = rows[0]?.last;
    if (last == null) return null;
    const d = parseChDateTime(last);
    if (d == null) return null;
    if (d.getUTCFullYear() < 2000) return null;
    return d;
  }

  /**
   * Read the shares+close panel for the requested tickers in
   * `[asOf - days, asOf]`. Subquery-around-FINAL (a52c964 regression class).
   * Returns a Map of ticker → sorted-ASC rows.
   */
  async readSharesPanelForTickers(
    asOf: Date,
    tickers: readonly string[],
    days: number = READ_WINDOW_CALENDAR_DAYS,
  ): Promise<Map<string, RawSharesRow[]>> {
    if (tickers.length === 0) return new Map();
    const asOfStr = toIsoDate(asOf);
    const startStr = toIsoDate(new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000));
    const q = await this.ch.query({
      query: `
        SELECT
          ticker,
          toString(date) AS date,
          shares,
          close
        FROM (
          SELECT ticker, date, shares, close
          FROM ${this.sourceTable} FINAL
          WHERE date >= {start:Date}
            AND date <= {asOf:Date}
            AND ticker IN ({tickers:Array(String)})
        )
        ORDER BY ticker, date ASC
      `,
      query_params: {
        start: startStr,
        asOf: asOfStr,
        tickers: [...tickers],
      },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawSharesRow>();
    const out = new Map<string, RawSharesRow[]>();
    for (const r of rows) {
      const arr = out.get(r.ticker) ?? [];
      arr.push(r);
      out.set(r.ticker, arr);
    }
    return out;
  }

  /**
   * Read max(date) per ticker — the most-recent CH row for staleness scalar.
   * Subquery-around-FINAL. Tickers with no rows are absent from the map.
   */
  async readMaxDateByTicker(
    asOf: Date,
    tickers: readonly string[],
  ): Promise<Map<string, Date>> {
    if (tickers.length === 0) return new Map();
    const asOfStr = toIsoDate(asOf);
    const q = await this.ch.query({
      query: `
        SELECT ticker, toString(max(date)) AS max_date
        FROM (
          SELECT ticker, date
          FROM ${this.sourceTable} FINAL
          WHERE date <= {asOf:Date}
            AND ticker IN ({tickers:Array(String)})
        )
        GROUP BY ticker
      `,
      query_params: { asOf: asOfStr, tickers: [...tickers] },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawMaxDateRow>();
    const out = new Map<string, Date>();
    for (const r of rows) {
      const d = parseIsoDate(r.max_date);
      if (d != null) out.set(r.ticker, d);
    }
    return out;
  }

  /**
   * Compose all inputs the A2 composite needs for `asOf`. Pure-function
   * composite consumes the result; the repository does ALL I/O + panel
   * assembly + carry-forward + baseline rolling.
   *
   * Tickers default to the F-UNIVERSE v1 set (21 ETFs) — caller may override
   * for tests. Tickers absent from the CH source-table get a structurally
   * empty per-ETF row (zero shares/closes); the composite's per-ETF layer
   * will surface them with null z-scores and 21-element panels of zeros. Per
   * F-9 cold-start propagation, any null z in a sector or broad slot kills
   * the corresponding aggregate.
   */
  async readInputsForCycle(
    asOf: Date,
    tickers: readonly string[] = ETF_UNIVERSE,
  ): Promise<EtfFlowInputs> {
    const [latestQueryAt, panelByTicker, maxDateByTicker] = await Promise.all([
      this.readLatestYfinanceQueryAt(asOf),
      this.readSharesPanelForTickers(asOf, tickers),
      this.readMaxDateByTicker(asOf, tickers),
    ]);

    const perEtf: EtfFlowPerEtfInput[] = tickers.map(ticker => {
      const rows = panelByTicker.get(ticker) ?? [];
      const maxDate = maxDateByTicker.get(ticker) ?? null;
      const bdSinceShareUpdate = maxDate != null
        ? businessDaysBetween(maxDate, asOf)
        : COLD_START_BD_SENTINEL;
      return assemblePerEtfInput(ticker, rows, asOf, bdSinceShareUpdate);
    });

    return { asOf, lastYfinanceQueryAt: latestQueryAt, perEtf };
  }

  /** Persist one snapshot. Idempotent under ReplacingMergeTree(computed_at)
   *  on (snapshot_date) per A3 schema. The A2 EtfFlowSnapshot.version field
   *  maps to the DDL's `composite_version` column at this boundary. The two
   *  aggregate Float64 scalars (sectorFlowDispersion, aggregateRiskOnFlow)
   *  are written into Float32 columns; ClickHouse coerces implicitly + the
   *  z-score range (~±5) loses no useful precision. */
  async writeSnapshot(snapshot: EtfFlowSnapshot): Promise<void> {
    const snapshotDate = toIsoDate(snapshot.snapshotDate);
    const computedAt = formatDateTime64(snapshot.snapshotDate);
    const lastQueryAt = snapshot.lastYfinanceQueryAt != null
      ? formatDateTime(snapshot.lastYfinanceQueryAt)
      : null;
    const perEtfJson = JSON.stringify(snapshot.perEtfRows);
    const flaggedEtfsJson = JSON.stringify(snapshot.flaggedEtfs);
    const aggregateJson = JSON.stringify({
      sectorFlowDispersion: snapshot.sectorFlowDispersion,
      aggregateRiskOnFlow: snapshot.aggregateRiskOnFlow,
      aggregateFlowStressFlag: snapshot.aggregateFlowStressFlag,
      inputsAvailableAggregateSector: snapshot.inputsAvailableAggregateSector,
      inputsAvailableAggregateBroad: snapshot.inputsAvailableAggregateBroad,
    });
    await this.ch.insert({
      table: this.snapshotsTable,
      values: [{
        snapshot_date: snapshotDate,
        computed_at: computedAt,
        last_yfinance_query_at: lastQueryAt,
        bd_since_last_share_update: snapshot.bdSinceLastShareUpdate,
        sector_flow_dispersion: snapshot.sectorFlowDispersion,
        aggregate_risk_on_flow: snapshot.aggregateRiskOnFlow,
        aggregate_flow_stress_flag: snapshot.aggregateFlowStressFlag ? 1 : 0,
        flagged_etfs_json: flaggedEtfsJson,
        per_etf_json: perEtfJson,
        aggregate_json: aggregateJson,
        inputs_available_aggregate_sector: snapshot.inputsAvailableAggregateSector,
        inputs_available_aggregate_broad: snapshot.inputsAvailableAggregateBroad,
        inputs_available_per_etf: snapshot.inputsAvailablePerEtf,
        composite_version: snapshot.version,
      }],
      format: 'JSONEachRow',
    });
  }

  /** Read the most-recent snapshot. Used by the morning brief (A5). */
  async loadLatestSnapshot(): Promise<EtfFlowSnapshot | null> {
    const q = await this.ch.query({
      query: `
        SELECT
          toString(snapshot_date) AS snapshot_date,
          toUnixTimestamp64Milli(computed_at) AS computed_at_ms,
          toString(last_yfinance_query_at) AS last_yfinance_query_at,
          bd_since_last_share_update,
          sector_flow_dispersion,
          aggregate_risk_on_flow,
          aggregate_flow_stress_flag,
          flagged_etfs_json,
          per_etf_json,
          aggregate_json,
          inputs_available_aggregate_sector,
          inputs_available_aggregate_broad,
          inputs_available_per_etf,
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
    if (r.last_yfinance_query_at) {
      const parsed = parseChDateTime(r.last_yfinance_query_at);
      if (parsed != null && parsed.getUTCFullYear() >= 2000) lastQueryAt = parsed;
    }
    let perEtfRows: ReadonlyArray<EtfFlowPerEtfRow> = [];
    try {
      const parsed = JSON.parse(r.per_etf_json);
      if (Array.isArray(parsed)) {
        perEtfRows = parsed as EtfFlowPerEtfRow[];
      }
    } catch {
      perEtfRows = [];
    }
    let flaggedEtfs: ReadonlyArray<EtfFlowFlaggedEtf> = [];
    try {
      const parsed = JSON.parse(r.flagged_etfs_json);
      if (Array.isArray(parsed)) {
        flaggedEtfs = parsed as EtfFlowFlaggedEtf[];
      }
    } catch {
      flaggedEtfs = [];
    }
    return {
      snapshotDate: new Date(Number(r.computed_at_ms)),
      lastYfinanceQueryAt: lastQueryAt,
      bdSinceLastShareUpdate: r.bd_since_last_share_update != null
        ? Number(r.bd_since_last_share_update)
        : null,
      sectorFlowDispersion: nullableNum(r.sector_flow_dispersion),
      aggregateRiskOnFlow: nullableNum(r.aggregate_risk_on_flow),
      aggregateFlowStressFlag: Number(r.aggregate_flow_stress_flag) === 1,
      flaggedEtfs,
      perEtfRows,
      inputsAvailableAggregateSector: Number(r.inputs_available_aggregate_sector),
      inputsAvailableAggregateBroad: Number(r.inputs_available_aggregate_broad),
      inputsAvailablePerEtf: Number(r.inputs_available_per_etf),
      version: r.composite_version as typeof ETF_FLOW_COMPOSITE_VERSION,
    };
  }
}

// ───── panel assembly ───────────────────────────────────────────────────────

/** Assemble the EtfFlowPerEtfInput for one ticker from sorted-ASC raw rows.
 *
 *  Steps:
 *    1. Parse raw rows into (date, shares, close) tuples; drop unparseable.
 *    2. Build a business-day panel ending at asOf, carry-forward across gaps
 *       (defensive — the ingest already densifies; this handles partial-
 *       failure days).
 *    3. Extract the trailing 21-element window (D-20bd through D) for the
 *       composite's shares21/closes21 inputs.
 *    4. Roll the 21-element window across the trailing year of business days
 *       to build the baseline1yFlowPctAum + baseline1yReturn20bd arrays.
 *
 *  Cold-start (insufficient panel length for the 21-element window): returns
 *  a structurally valid per-ETF input with zero-filled panels and empty
 *  baselines, so the composite's `computeFlowDollar20bd` does NOT throw on
 *  panel-length-mismatch. The composite then produces a per-ETF row with
 *  null z-scores (cold-start surfaces via inputsAvailablePerEtf < universe-
 *  size in the snapshot diagnostic counts).
 *
 *  Exported for direct testing.
 */
export function assemblePerEtfInput(
  ticker: string,
  rows: ReadonlyArray<RawSharesRow>,
  asOf: Date,
  bdSinceShareUpdate: number,
): EtfFlowPerEtfInput {
  // Parse + sort defensively (CH ORDER BY already gives us ascending, but
  // belt-and-suspenders).
  const points: { date: Date; shares: number; close: number }[] = [];
  for (const r of rows) {
    const d = parseIsoDate(r.date);
    if (d == null) continue;
    const shares = toNum(r.shares);
    const close = toNum(r.close);
    if (shares == null || close == null) continue;
    points.push({ date: d, shares, close });
  }
  points.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Cold-start: insufficient prints for even the 21-element window.
  if (points.length < FLOW_WINDOW_BD + 1) {
    return {
      ticker,
      shares21: new Array(FLOW_WINDOW_BD + 1).fill(0),
      closes21: new Array(FLOW_WINDOW_BD + 1).fill(0),
      baseline1yFlowPctAum: [],
      baseline1yReturn20bd: [],
      bdSinceShareUpdate,
    };
  }

  // Build a contiguous business-day panel ending at asOf, carrying forward
  // across any gaps. The ingest densifies, so for the common case this is a
  // no-op (each business day already has a row). The defensive path catches
  // partial-ingest gaps.
  const panel = densifyBusinessDayPanel(points, asOf);

  // Extract the trailing 21-element window (FLOW_WINDOW_BD + 1 = 21).
  if (panel.length < FLOW_WINDOW_BD + 1) {
    return {
      ticker,
      shares21: new Array(FLOW_WINDOW_BD + 1).fill(0),
      closes21: new Array(FLOW_WINDOW_BD + 1).fill(0),
      baseline1yFlowPctAum: [],
      baseline1yReturn20bd: [],
      bdSinceShareUpdate,
    };
  }
  const shares21 = panel.slice(-1 * (FLOW_WINDOW_BD + 1)).map(p => p.shares);
  const closes21 = panel.slice(-1 * (FLOW_WINDOW_BD + 1)).map(p => p.close);

  // Build the trailing-1y baselines by sliding a 21-element window across the
  // panel. The current snapshot's window (panel.length - 1) is EXCLUDED from
  // the baseline (per F-2, baseline is trailing 1y of HISTORICAL prints — the
  // current value is what we're z-scoring, not part of the baseline).
  //
  // For each candidate end-index endIdx in [FLOW_WINDOW_BD, panel.length - 2]:
  //   - slice the 21-element window [endIdx - 20 .. endIdx]
  //   - compute flow_dollar_20bd → flow_pct_aum at that endIdx
  //   - compute return_20bd at that endIdx
  //   - append to baselines (skip if either is null — degenerate AUM/close)
  //
  // Cap the trailing window at BASELINE_TARGET_BUSINESS_DAYS to keep the
  // baseline at the steady-state 252-print target.
  const baseline1yFlowPctAum: number[] = [];
  const baseline1yReturn20bd: number[] = [];
  const lastBaselineEnd = panel.length - 2;
  const firstBaselineEnd = Math.max(
    FLOW_WINDOW_BD,
    lastBaselineEnd - BASELINE_TARGET_BUSINESS_DAYS + 1,
  );
  for (let endIdx = firstBaselineEnd; endIdx <= lastBaselineEnd; endIdx++) {
    const winShares = panel.slice(endIdx - FLOW_WINDOW_BD, endIdx + 1).map(p => p.shares);
    const winCloses = panel.slice(endIdx - FLOW_WINDOW_BD, endIdx + 1).map(p => p.close);
    const sharesEnd = winShares[winShares.length - 1];
    const closeEnd = winCloses[winCloses.length - 1];
    const closeStart = winCloses[0];
    const flowDollar = computeFlowDollar20bd(winShares, winCloses);
    const flowPct = computeFlowPctAum(flowDollar, sharesEnd, closeEnd);
    const ret20 = computeReturn20bd(closeEnd, closeStart);
    if (flowPct != null && Number.isFinite(flowPct)) baseline1yFlowPctAum.push(flowPct);
    if (ret20 != null && Number.isFinite(ret20)) baseline1yReturn20bd.push(ret20);
  }

  return {
    ticker,
    shares21,
    closes21,
    baseline1yFlowPctAum,
    baseline1yReturn20bd,
    bdSinceShareUpdate,
  };
}

/** Densify a sparse-or-dense point list to a contiguous business-day panel
 *  ending at asOf. Carry-forward across gaps; the leading edge starts at
 *  the first available print (no leading carry-forward — matches the A1
 *  ingest's "drop pre-first-print rows" semantic).
 *
 *  Exported for direct testing.
 */
export function densifyBusinessDayPanel(
  points: ReadonlyArray<{ date: Date; shares: number; close: number }>,
  asOf: Date,
): Array<{ date: Date; shares: number; close: number }> {
  if (points.length === 0) return [];
  const out: Array<{ date: Date; shares: number; close: number }> = [];
  const sorted = [...points].sort((a, b) => a.date.getTime() - b.date.getTime());
  const firstDate = sorted[0].date;
  const endDate = utcDateOnly(asOf);
  let pointIdx = 0;
  let lastShares = sorted[0].shares;
  let lastClose = sorted[0].close;
  const cur = utcDateOnly(firstDate);
  while (cur.getTime() <= endDate.getTime()) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      // Advance pointIdx through any points dated ≤ cur to update the carry-
      // forward state with the most recent known value.
      while (pointIdx < sorted.length && sorted[pointIdx].date.getTime() <= cur.getTime()) {
        lastShares = sorted[pointIdx].shares;
        lastClose = sorted[pointIdx].close;
        pointIdx++;
      }
      out.push({
        date: new Date(cur.getTime()),
        shares: lastShares,
        close: lastClose,
      });
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// ───── helpers ──────────────────────────────────────────────────────────────

function utcDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
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

function toIsoDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function formatDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function formatDateTime64(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

function parseIsoDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10))) return null;
  const d = new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseChDateTime(s: string): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?/);
  if (!m) {
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
 *  Mon-Fri only; holidays not accounted for. Same shape as short-interest +
 *  exec-departure (matches across all Layer-0 repository helpers). */
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
 *  Mirrors the absent-table-safe gate from exec-departure / short-interest. */
export async function etfFlowSnapshotsTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'etf_flow_snapshots'`,
      format: 'JSONEachRow',
    });
    const [{ n }] = await r.json<{ n: string | number }>();
    return Number(n) > 0;
  } catch {
    return false;
  }
}

/** Module-level probe: does the source table exist?
 *  Used by the daemon to skip step 1j cleanly when the gap #9 A1 ingest has
 *  never run (in which case there's nothing to compose). */
export async function etfSharesOutstandingTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'etf_shares_outstanding'`,
      format: 'JSONEachRow',
    });
    const [{ n }] = await r.json<{ n: string | number }>();
    return Number(n) > 0;
  } catch {
    return false;
  }
}

/**
 * Daemon orchestration: read panel → compose → persist one snapshot.
 * Wired into scripts/daily_signal_daemon.ts as step 1j (after step 1i
 * exec-departure).
 *
 * The orchestrator defaults to the F-UNIVERSE v1 21-ETF tickers; tests
 * inject smaller lists for fixture-driven assertions.
 */
export async function runDaemonEtfFlowEvaluation(opts: {
  repo: EtfFlowRepository;
  asOf: Date;
  tickers?: readonly string[];
}): Promise<EtfFlowDaemonResult> {
  const tickers = opts.tickers ?? ETF_UNIVERSE;
  const inputs = await opts.repo.readInputsForCycle(opts.asOf, tickers);
  const snapshot = evaluateEtfFlowComposite(inputs);
  await opts.repo.writeSnapshot(snapshot);

  const dispStr = snapshot.sectorFlowDispersion != null
    ? snapshot.sectorFlowDispersion.toFixed(2)
    : '—';
  const riskOnStr = snapshot.aggregateRiskOnFlow != null
    ? snapshot.aggregateRiskOnFlow.toFixed(2)
    : '—';
  const lastQueryStr = snapshot.lastYfinanceQueryAt != null
    ? toIsoDate(snapshot.lastYfinanceQueryAt)
    : '—';
  const staleness = snapshot.bdSinceLastShareUpdate;
  const summaryLine =
    `[etf-flow] ${toIsoDate(opts.asOf)} ` +
    `sector_disp=${dispStr} risk_on=${riskOnStr} ` +
    `stress=${snapshot.aggregateFlowStressFlag ? 'YES' : 'NO'} ` +
    `flagged=${snapshot.flaggedEtfs.length} ` +
    `etfs=${snapshot.inputsAvailablePerEtf}/${tickers.length} ` +
    `sector=${snapshot.inputsAvailableAggregateSector}/11 ` +
    `broad=${snapshot.inputsAvailableAggregateBroad}/6 ` +
    `last_yfinance=${lastQueryStr} ` +
    `(${staleness != null && Number.isFinite(staleness) ? `${staleness}bd` : '—'})`;

  return { snapshot, inputs, summaryLine };
}

/**
 * What could break this:
 *   - The defensive carry-forward in densifyBusinessDayPanel is belt-and-
 *     suspenders against partial-ingest gaps. If the ingest's densification
 *     ever changes semantics (e.g., switches to interpolation), this layer's
 *     forward-fill would silently disagree. Test fixtures pin the carry-
 *     forward semantic explicitly.
 *   - bdSinceShareUpdate is computed from max(date) in CH, which equals the
 *     last business day the ingest produced a row — NOT the last yfinance
 *     raw print. A ticker whose yfinance shares-outstanding has not changed
 *     for 30bd but whose ingest has run daily will report bd=0, masking the
 *     "no shares update" state. v2 enhancement: add an `is_carry_forward
 *     UInt8` column at A1 to disambiguate. v1 accepts this limitation as
 *     documented in the module header.
 *   - The composite's `computeFlowDollar20bd` throws on a wrong panel length.
 *     assemblePerEtfInput guards by checking panel.length ≥ FLOW_WINDOW_BD+1
 *     before slicing; cold-start (< 21 prints) emits a zero-filled panel +
 *     empty baselines which produce null z-scores (correct semantic — the
 *     composite surfaces cold-start via inputsAvailablePerEtf < universe).
 *   - Float32 downcast at the writeSnapshot boundary: CH coerces the Float64
 *     `sectorFlowDispersion` / `aggregateRiskOnFlow` values to Float32 on
 *     insert. z-scores ±5 fit within Float32 ~7-decimal precision; no
 *     meaningful precision loss. Explicit toFloat32() not required.
 *   - The `composite_version` column maps from the A2 type's `version` field.
 *     A bug that writes `version: snapshot.version` directly into a different
 *     column name (e.g., `version` not `composite_version`) would silently
 *     produce a ClickHouse "Unknown column" error. The writeSnapshot test
 *     pins the column name explicitly.
 *   - loadLatestSnapshot constructs `snapshotDate` from `toUnixTimestamp64Milli
 *     (computed_at)`, NOT from the `snapshot_date` Date column — this preserves
 *     millisecond resolution of the daemon-write moment. A Date-only column
 *     would lose intra-day re-runs to a single ReplacingMergeTree slot.
 *   - readSp500ConstituentsPIT does not exist on this repository — the v1
 *     universe is the fixed F-UNIVERSE 21-ETF list, not a SPY-500
 *     reconstruction. The composite's aggregate slots (11 sector + 6 broad)
 *     are picked from F-UNIVERSE by `resolveEtfGroup` in src/server/etf_flow.ts.
 *   - The trailing-1y baseline slice is capped at BASELINE_TARGET_BUSINESS_DAYS
 *     (252). At steady state every ticker has ≥252 prints; in cold-start the
 *     baseline is shorter and the composite's MIN_Z_BASELINE = 30 floor
 *     gates the z-score validity.
 *   - Empty tickers list propagates cleanly: per-ETF rows empty; aggregates
 *     null; flag false. The daemon's anomaly-push handles visibility.
 */
