/**
 * Form 4 insider repository — reads SEC EDGAR Form 4 transaction rows from
 * `quantlab.insider_trades`, resolves the equity-midcap watch universe +
 * SPY-500 PIT constituent panel, composes inputs for the F4-A2 composite,
 * writes daily snapshots (Phase F4-A4).
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §3 (component diagram),
 *       §5.3-§5.4 (composite formulas), §6.2 (snapshot schema), §7 (daemon
 *       hook 1l), §9.8 (T-F4R-1..T-F4R-Nplus6).
 *
 * Responsibility split (mirrors eight_k_classifier_repository.ts byte-for-byte
 * where mechanics line up):
 *   - Pure composite logic lives in src/server/form_4_insider.ts (F4-A2 —
 *     pinned). The composite is universe-agnostic — it consumes a per-ticker
 *     trade panel + a sector-aggregate panel and emits the snapshot shape.
 *   - This repository is the I/O boundary: pulls the trailing 90d trade panel
 *     per ticker from `quantlab.insider_trades` (where F4-A1 already stored
 *     the resolved `issuer_ticker` column on each row), resolves the
 *     equity-midcap watch universe from `quantlab.candles`, reads the SPY-500
 *     PIT constituent panel + the issuer CIK↔ticker reverse cache, feeds the
 *     composite, writes the snapshot to quantlab.form_4_insider_snapshots.
 *
 * GICS sector mapping — v1 autonomous resolution (SPEC §11 OQ-x canon-thin fork;
 * identical posture to gap #8 + gap #7 EK-A4 + module-header precedent):
 *
 *   SPEC §5.4 + §6.2 formulate the aggregate signal at the GICS-sector slice
 *   of the SPY-500 constituent panel. Neither the SP500 constituents table
 *   nor the `cik_ticker_map` cache carries a SIC code or GICS sector field;
 *   the existing SPDR-sector mapping in src/server/sector_rotation.ts is at
 *   the ETF level (XLK/XLF/...), NOT at the constituent level.
 *
 *   v1 ships with `sector = null` for ALL per-ticker rows. Per F4-2 the
 *   per-ticker layer is fully active (cluster-buy / cluster-sell flags fire
 *   on raw distinct-insider count) and does NOT require sector. The
 *   composite's `inputs.sectors` array is empty in v1 — the aggregate
 *   `form_4_cluster_flag` is cold-start and never fires. The brief panel
 *   (F4-A5) will render a "GICS sector mapping deferred to v2" footer for the
 *   aggregate panel.
 *
 *   Three-criterion analysis (per CLAUDE.md autonomous-execution canon-thin
 *   rule): equal across alternatives, but null-sector v1 has zero ingest-time
 *   changes (F4-A1 immutable within slice arc), zero free parameters, and is
 *   byte-for-byte the same v1 deferral as EK-A4. v2 deliverable: a single
 *   `quantlab.gics_sector_map` slice activates BOTH EK + F4 + gap #8
 *   aggregate panels.
 *
 * Anti-leak gate (load-bearing per SPEC §4.1 + §11 + F4-10):
 *   All trade reads filter on `accepted_at <= asOf` (NOT `transaction_date`).
 *   The composite's window math also uses `acceptedAt` per F4-10. A refactor
 *   that swapped to `transaction_date` would introduce a look-ahead leak —
 *   insiders have up to 2 business days to file post-trade per 17 CFR
 *   240.16a-3.
 *
 * Defensive {P, S} read filter (S93-37 + F4-4):
 *   Ingest stores ALL transaction codes per F4-A1 by design (A grants, M
 *   exercises, F payments, G gifts, plus the {P, S} composite-eligible
 *   codes). This repository narrows the read to {P, S} at SQL time to save
 *   bytes; the composite's `filterTradesToHighSignalCodes` is defense-in-
 *   depth on the in-memory side.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';
import {
  evaluateForm4InsiderComposite,
  FORM_4_INSIDER_COMPOSITE_VERSION,
  HIGH_SIGNAL_TRANSACTION_CODES,
  ROLLING_WINDOW_DAYS,
  type Form4InsiderFlaggedSector,
  type Form4InsiderInputs,
  type Form4InsiderPerTickerRow,
  type Form4InsiderSnapshot,
  type InsiderTrade,
} from './form_4_insider.js';

/** Trailing window per F4-5 for the per-ticker rolling 90d net-dollar set. */
export const TRADE_WINDOW_DAYS = ROLLING_WINDOW_DAYS;

/** Baseline window for the sector-aggregate z-score: 2 calendar years.
 *  Matches the executive-departure + short-interest + EK-A4
 *  BASELINE_CALENDAR_DAYS constant. Per EDF-7 the MIN_Z_BASELINE = 30 floor
 *  lives in the composite layer; this constant governs only the I/O window
 *  read by the repository when v2 GICS sector activation lands. */
export const BASELINE_CALENDAR_DAYS = 730;

/** Composite reads only open-market codes per F4-4. The ingest stores all
 *  codes per S93-37; the repository narrows on read for read-amplification
 *  AND defensive correctness. The composite filters again on the in-memory
 *  side (defense-in-depth). */
export const COMPOSITE_TRANSACTION_CODES = HIGH_SIGNAL_TRANSACTION_CODES;

export interface Form4InsiderRepositoryOptions {
  ch?: ClickHouseClient;
  insiderTradesTable?: string;
  sp500ConstituentsTable?: string;
  cikTickerMapTable?: string;
  candlesTable?: string;
  snapshotsTable?: string;
}

export interface Form4InsiderDaemonResult {
  snapshot: Form4InsiderSnapshot;
  inputs: Form4InsiderInputs;
  summaryLine: string;
}

interface RawTradeRow {
  issuer_ticker: string;
  issuer_cik: string;
  accession: string;
  transaction_id: number | string;
  person_cik: string;
  role_flags: number | string;
  transaction_code: string;
  accepted_at: string;
  shares: number | string;
  price_per_share: number | string;
  dollar_amount: number | string;
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

interface RawSnapshotRow {
  snapshot_date: string;
  computed_at_ms: string | number;
  last_edgar_query_at: string | null;
  bd_since_last_query: number | null;
  form_4_cluster_flag: number | string;
  flagged_sectors_json: string;
  per_ticker_json: string;
  inputs_available_aggregate: number | string;
  inputs_available_per_ticker: number | string;
  composite_version: string;
}

export class Form4InsiderRepository {
  private readonly ch: ClickHouseClient;
  readonly insiderTradesTable: string;
  readonly sp500ConstituentsTable: string;
  readonly cikTickerMapTable: string;
  readonly candlesTable: string;
  readonly snapshotsTable: string;

  constructor(opts: Form4InsiderRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.insiderTradesTable = opts.insiderTradesTable ?? 'quantlab.insider_trades';
    this.sp500ConstituentsTable = opts.sp500ConstituentsTable ?? 'quantlab.sp500_constituents';
    this.cikTickerMapTable = opts.cikTickerMapTable ?? 'quantlab.cik_ticker_map';
    this.candlesTable = opts.candlesTable ?? 'quantlab.candles';
    this.snapshotsTable = opts.snapshotsTable ?? 'quantlab.form_4_insider_snapshots';
  }

  /**
   * Latest EDGAR acceptance datetime ≤ asOf — used for the
   * `last_edgar_query_at` + `bd_since_last_query` staleness indicators in
   * the snapshot. Returns null when no trades exist yet (table empty /
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
          FROM ${this.insiderTradesTable} FINAL
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
   * Read all Form 4 trades with `accepted_at` in `[asOf - windowDays, asOf]`
   * and `transaction_code` ∈ {P, S} for the given ticker list.
   * Subquery-around-FINAL (a52c964 regression class).
   *
   * The composite re-filters internally (defense-in-depth per F4-4 + S93-37);
   * narrowing to the open-market set at read time saves bytes for the common
   * case where insiders also file A grants, M exercises, G gifts, etc.
   *
   * Returns a Map of issuer_ticker → trades[]. Tickers with zero trades get
   * no map entry; the consumer treats absent as empty.
   */
  async readTradesForTickersInWindow(
    asOf: Date,
    tickers: readonly string[],
    windowDays: number = TRADE_WINDOW_DAYS,
  ): Promise<Map<string, InsiderTrade[]>> {
    if (tickers.length === 0) return new Map();
    const asOfStr = toIsoDateTime(asOf);
    const startStr = toIsoDateTime(
      new Date(asOf.getTime() - windowDays * 24 * 60 * 60 * 1000),
    );
    const q = await this.ch.query({
      query: `
        SELECT
          issuer_ticker,
          issuer_cik,
          accession,
          transaction_id,
          person_cik,
          role_flags,
          transaction_code,
          toString(accepted_at) AS accepted_at,
          shares,
          price_per_share,
          dollar_amount
        FROM (
          SELECT
            issuer_ticker, issuer_cik, accession, transaction_id,
            person_cik, role_flags, transaction_code, accepted_at,
            shares, price_per_share, dollar_amount
          FROM ${this.insiderTradesTable} FINAL
          WHERE accepted_at >= {start:DateTime}
            AND accepted_at <= {asOf:DateTime}
            AND issuer_ticker IN ({tickers:Array(String)})
            AND transaction_code IN ({codes:Array(String)})
        )
      `,
      query_params: {
        start: startStr,
        asOf: asOfStr,
        tickers: [...tickers],
        codes: [...COMPOSITE_TRANSACTION_CODES],
      },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawTradeRow>();
    return groupTradesByTicker(rows);
  }

  /**
   * Read the SPY-500 PIT constituent panel as-of asOf. Per SPEC §4.1 the
   * aggregate universe is "the constituent list AT the snapshot date, not
   * today's." Falls back to the latest available effective_date when no row
   * is dated ≤ asOf — matches the short-interest + exec-departure + EK-A4 posture.
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
   * the exec-departure + short-interest + EK-A4 precedents.
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
   * sector (sector always null in v1).
   *
   * NOTE: this is the ISSUER CIK lookup, not the person CIK. Person CIKs
   * are read directly from the `person_cik` column on each insider_trades
   * row per HANDOFF S93 F4-A4: "NO join to insider_ciks is needed at
   * composite-eval time (the name cache is render-only, used by F4-A5)."
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
   * Compose all inputs the F4-A2 composite needs for `asOf`. Pure-function
   * composite consumes the result; the repository does ALL I/O + windowing.
   *
   * Caller supplies the watch universe (equity-midcap symbol list) + the
   * SPY-500 PIT constituent list. The orchestrator helper
   * `runDaemonForm4InsiderEvaluation` resolves these from CH; tests inject
   * fixed lists.
   *
   * v1 aggregate-sector slicing is inactive per the module header —
   * `inputs.sectors` is an empty array. v2 will populate it from the GICS
   * mapping table.
   */
  async readInputsForCycle(
    asOf: Date,
    watchUniverse: readonly string[],
    _constituents: readonly string[],
  ): Promise<Form4InsiderInputs> {
    const [latestAccepted, cikByTicker, perTickerTrades] = await Promise.all([
      this.readLatestAcceptedAt(asOf),
      this.readCikByTicker(watchUniverse),
      this.readTradesForTickersInWindow(asOf, watchUniverse, TRADE_WINDOW_DAYS),
    ]);

    const perTicker = watchUniverse.map(ticker => ({
      ticker,
      cik: cikByTicker.get(ticker) ?? '',
      sector: null as string | null,
      trades: perTickerTrades.get(ticker) ?? [],
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
   *  ReplacingMergeTree(computed_at) on (snapshot_date) per F4-A3 schema.
   *  The F4-A2 Form4InsiderSnapshot.version field maps to the DDL's
   *  `composite_version` column at this boundary (load-bearing per S93-A3:
   *  the snapshot table has NO DEFAULT on composite_version; daemon MUST
   *  write it explicitly or CH stores an empty LowCardinality string —
   *  mirrors the EK-A4 + S93-24 watch-out exactly). */
  async writeSnapshot(snapshot: Form4InsiderSnapshot): Promise<void> {
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
        form_4_cluster_flag: snapshot.form4ClusterFlag ? 1 : 0,
        flagged_sectors_json: flaggedSectorsJson,
        per_ticker_json: perTickerJson,
        inputs_available_aggregate: snapshot.inputsAvailableAggregate,
        inputs_available_per_ticker: snapshot.inputsAvailablePerTicker,
        composite_version: snapshot.version,
      }],
      format: 'JSONEachRow',
    });
  }

  /** Read the most-recent snapshot. Used by the morning brief (F4-A5).
   *  Subquery-around-FINAL via the outer FROM + LIMIT 1. */
  async loadLatestSnapshot(): Promise<Form4InsiderSnapshot | null> {
    const q = await this.ch.query({
      query: `
        SELECT
          toString(snapshot_date) AS snapshot_date,
          toUnixTimestamp64Milli(computed_at) AS computed_at_ms,
          toString(last_edgar_query_at) AS last_edgar_query_at,
          bd_since_last_query,
          form_4_cluster_flag,
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
    let perTickerRows: ReadonlyArray<Form4InsiderPerTickerRow> = [];
    try {
      const parsed = JSON.parse(r.per_ticker_json);
      if (Array.isArray(parsed)) {
        perTickerRows = parsed as Form4InsiderPerTickerRow[];
      }
    } catch {
      perTickerRows = [];
    }
    let flaggedSectors: ReadonlyArray<Form4InsiderFlaggedSector> = [];
    try {
      const parsed = JSON.parse(r.flagged_sectors_json);
      if (Array.isArray(parsed)) {
        flaggedSectors = parsed as Form4InsiderFlaggedSector[];
      }
    } catch {
      flaggedSectors = [];
    }
    return {
      snapshotDate: new Date(Number(r.computed_at_ms)),
      lastEdgarQueryAt: lastQueryAt,
      bdSinceLastQuery: r.bd_since_last_query != null ? Number(r.bd_since_last_query) : null,
      flaggedSectors,
      form4ClusterFlag: Number(r.form_4_cluster_flag) === 1,
      perTickerRows,
      inputsAvailableAggregate: Number(r.inputs_available_aggregate),
      inputsAvailablePerTicker: Number(r.inputs_available_per_ticker),
      version: r.composite_version as typeof FORM_4_INSIDER_COMPOSITE_VERSION,
    };
  }
}

// ───── helpers ──────────────────────────────────────────────────────────────

function groupTradesByTicker(
  rows: readonly RawTradeRow[],
): Map<string, InsiderTrade[]> {
  const out = new Map<string, InsiderTrade[]>();
  for (const r of rows) {
    const acceptedAt = parseChDateTime(r.accepted_at);
    if (acceptedAt == null) continue;
    const trade: InsiderTrade = {
      accession: r.accession,
      transactionId: Number(r.transaction_id),
      issuerCik: r.issuer_cik,
      issuerTicker: r.issuer_ticker ?? '',
      personCik: r.person_cik,
      roleFlags: Number(r.role_flags),
      transactionCode: r.transaction_code,
      acceptedAt,
      shares: Number(r.shares),
      pricePerShare: Number(r.price_per_share),
      dollarAmount: Number(r.dollar_amount),
    };
    const arr = out.get(trade.issuerTicker) ?? [];
    arr.push(trade);
    out.set(trade.issuerTicker, arr);
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
 *  short-interest + etf-flow + EK-A4 (matches across all Layer-0 repository
 *  helpers). */
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
 *  short-interest / EK-A4. */
export async function form4InsiderSnapshotsTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'form_4_insider_snapshots'`,
      format: 'JSONEachRow',
    });
    const [{ n }] = await r.json<{ n: string | number }>();
    return Number(n) > 0;
  } catch {
    return false;
  }
}

/** Module-level probe: does the source table exist?
 *  Used by the daemon to skip step 1l cleanly when the F4-A1 ingest has
 *  never run (no trades to read). */
export async function insiderTradesTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'insider_trades'`,
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
 * Wired into scripts/daily_signal_daemon.ts as step 1l (after step 1k
 * eight-k, before §2 cells/bundles per SPEC §7).
 *
 * The orchestrator resolves the equity-midcap watch universe + SPY-500 PIT
 * constituents from CH, then composes + writes a single snapshot.
 *
 * Pre-passed `watchUniverse` / `constituents` override the CH reads — tests
 * inject fixed lists; the daemon path lets the orchestrator resolve them
 * itself.
 */
export async function runDaemonForm4InsiderEvaluation(opts: {
  repo: Form4InsiderRepository;
  asOf: Date;
  watchUniverse?: readonly string[];
  constituents?: readonly string[];
}): Promise<Form4InsiderDaemonResult> {
  const watchUniverse = opts.watchUniverse
    ?? await opts.repo.readEquityMidcapWatchUniverse();
  const constituents = opts.constituents
    ?? await opts.repo.readSp500ConstituentsPIT(opts.asOf);
  const inputs = await opts.repo.readInputsForCycle(opts.asOf, watchUniverse, constituents);
  const snapshot = evaluateForm4InsiderComposite(inputs);
  await opts.repo.writeSnapshot(snapshot);

  const buyClusterCount = snapshot.perTickerRows.filter(r => r.insiderClusterBuyFlag).length;
  const sellClusterCount = snapshot.perTickerRows.filter(r => r.insiderClusterSellFlag).length;
  const lastQueryStr = snapshot.lastEdgarQueryAt != null
    ? toIsoDate(snapshot.lastEdgarQueryAt)
    : '—';
  const bdSince = snapshot.bdSinceLastQuery;
  const summaryLine =
    `[form-4] ${toIsoDate(opts.asOf)} ` +
    `cluster=${snapshot.form4ClusterFlag ? 'YES' : 'NO'} ` +
    `flagged_sectors=${snapshot.flaggedSectors.length} ` +
    `buy_clusters=${buyClusterCount} sell_clusters=${sellClusterCount} ` +
    `universe=${snapshot.inputsAvailablePerTicker}/${watchUniverse.length} ` +
    `agg=${snapshot.inputsAvailableAggregate}/${constituents.length} ` +
    `last_edgar=${lastQueryStr} (${bdSince != null ? `${bdSince}bd` : '—'})`;

  return { snapshot, inputs, summaryLine };
}

/**
 * What could break this:
 *   - The v1 GICS-sector deferral means `inputs.sectors` is always empty +
 *     `inputsAvailableAggregate` is always 0. The composite's aggregate
 *     layer is structurally dormant. v2 simply needs to populate the
 *     sectors array; the composite math (cluster_rate_t + z-score) is
 *     already implemented + tested in F4-A2. Mirrors EK-A4 posture
 *     identically.
 *   - `inputsAvailablePerTicker` from the composite counts only rows with
 *     non-empty CIK AND non-null sector — so in v1 it is always 0 even
 *     when every ticker has a CIK mapping. The F4-A5 brief needs its own
 *     "ticker has CIK" count if it wants to render SPEC §8.2's
 *     "X/Y mid-cap tickers have current CIK mapping" line. Matches the
 *     EK-A4 + exec-departure + short-interest cold-start posture for v1.
 *   - readTradesForTickersInWindow narrows to transaction_code IN {P, S} —
 *     if a future v2 ADR widens the code set (e.g., adds "M" exercises),
 *     the COMPOSITE_TRANSACTION_CODES re-export from `form_4_insider.ts`
 *     carries the new code automatically. Re-ingest is NOT required to
 *     backfill because ingest stores ALL codes per F4-A1; the SQL filter
 *     just opens the gate wider.
 *   - The CH `insider_trades` table is ReplacingMergeTree(ingested_at) ORDER
 *     BY (issuer_cik, accession, transaction_id). FINAL collapses re-ingest
 *     duplicates across the primary key tuple. The composite's `dedupeTrades`
 *     is defense-in-depth for the case where two rows still survive a FINAL
 *     (e.g. merge backlog).
 *   - businessDaysBetween counts weekdays only; US market holidays not
 *     accounted for. Same staleness-rough-signal posture as EK-A4 +
 *     exec-departure + etf-flow.
 *   - Empty watch universe / empty constituents propagate cleanly: per-ticker
 *     payload is empty; aggregate inputs are empty; composite returns a
 *     snapshot with form_4_cluster_flag = false and zero flagged rows. The
 *     daemon's anomaly-push handles the visibility.
 *   - readLatestAcceptedAt + readTradesForTickersInWindow both filter on
 *     `accepted_at`, NOT `transaction_date`, per the load-bearing F4-10
 *     lock. A refactor that swapped to `transaction_date` would introduce
 *     a look-ahead-leak vector (insiders have up to 2 business days to
 *     file post-trade per 17 CFR 240.16a-3).
 *   - readCikByTicker is one-way (current ticker → issuer CIK). Historical
 *     aliases stored in `former_tickers` are NOT consulted; tickers that
 *     swapped names mid-window will have rows in `insider_trades` keyed on
 *     the CURRENT `issuer_ticker` (F4-A1's ticker resolver writes the XML-
 *     supplied or submissions-API-resolved ticker into the row, so
 *     historical lookup IS preserved via the `issuer_ticker` column, not
 *     via the map). The map is for the daemon's reverse-lookup-from-watch-
 *     universe path only.
 *   - Person CIK ≠ Issuer CIK (F4-9 + S93-39). `readCikByTicker` returns
 *     ONLY issuer CIKs. Person CIKs are read straight from the `person_cik`
 *     column on each insider_trades row; no JOIN to `insider_ciks` at
 *     composite-eval time. The `insider_ciks` cache is consumed by F4-A5
 *     (brief render) for person-name display only.
 *   - Composite's `lastEdgarQueryAt` passes through from
 *     readLatestAcceptedAt — but the SPEC §11 OQ-4 semantic is "most recent
 *     successful POLL" not "most recent FILING." For v1 these are
 *     conflated (every poll-with-rows writes ingested_at; we read
 *     accepted_at because that's the leak-safe anchor). If a future v2
 *     tracks "polled with zero new trades" as a separate state, the
 *     daemon would need to write a side-channel timestamp; v1 uses the
 *     observable-from-data approximation. Mirrors EK-A4 exactly.
 *   - The summary-line shape diverges from EK-A4 deliberately: F4 reports
 *     `buy_clusters=N sell_clusters=N` (per-ticker flag counts, since v1's
 *     aggregate sector layer is dormant); EK reports `material=N` (per-
 *     ticker material-event-flag count). Renderers that pattern-match
 *     the prefix `[eight-k]` vs `[form-4]` will work; renderers that
 *     pattern-match on `material=` or `cluster=` need to know which
 *     composite emitted the line.
 *   - Defensive read filter `transaction_code IN {P, S}` is a load-bearing
 *     bytes optimization. Removing it would not affect correctness (the
 *     composite re-filters) but would inflate read amplification by ~5-10x
 *     for typical insider-filing mix (grants + exercises dominate by raw
 *     row count).
 */
