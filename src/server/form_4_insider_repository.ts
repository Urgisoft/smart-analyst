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
 * GICS sector mapping — gap #7+#8 v2 G1-A2 wiring (s94 #2; UPGRADED from
 * v1 null-sector posture per HANDOFF S94-1..S94-4):
 *
 *   SPEC §5.4 + §6.2 formulate the aggregate signal at the GICS-sector slice
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
 *   Aggregate-sector layer: STILL DORMANT in G1-A2 — `inputs.sectors` remains
 *   an empty array. The aggregate layer needs a per-sector daily cluster-rate
 *   2y baseline; the baseline-computation strategy (re-compute vs persist
 *   sibling table vs hybrid) is OQ-G2-1, a separate operator ADR. Activation
 *   ships as G2 once the ADR lands.
 *
 *   Three-criterion analysis (canon-thin fork resolution per CLAUDE.md): the
 *   per-ticker / aggregate decomposition has zero free parameters, mirrors the
 *   PIT-DESC pattern used elsewhere in the repository (see
 *   readSp500ConstituentsPIT), and aligns the consumer read pattern with v2
 *   PIT backfill without touching the schema (s94 #1 S94-2 lock).
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
  BUY_CODE,
  SELL_CODE,
  EDGAR_CANONICAL_SOURCE,
  computeSectorClusterRate,
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
import {
  findGoverningSector,
  readGicsSectorByTicker,
  readGicsSectorTimeline,
  readSectorMembershipPanel,
  type GicsSectorEntry,
} from './gics_sector_repository_helper.js';

/** Trailing window per F4-5 for the per-ticker rolling 90d net-dollar set. */
export const TRADE_WINDOW_DAYS = ROLLING_WINDOW_DAYS;

/** Baseline window for the sector-aggregate z-score: 2 calendar years.
 *  Matches the executive-departure + short-interest + EK-A4
 *  BASELINE_CALENDAR_DAYS constant. Per EDF-7 the MIN_Z_BASELINE = 30 floor
 *  lives in the composite layer; this constant governs only the I/O window
 *  read by the repository when v2 GICS sector activation lands. */
export const BASELINE_CALENDAR_DAYS = 730;

/** ADR-052 D2 — trailing window (calendar days) over which system-wide EDGAR
 *  P/S filing volume is summed to decide whether a baseline day is admitted.
 *  Set equal to the composite's `CLUSTER_WINDOW_DAYS` (30): the cluster rate a
 *  baseline day measures is itself a trailing-30d window, so "was EDGAR
 *  ingesting over the window this rate is measured on?" is the right coverage
 *  question. Inheriting the existing 30d window means ZERO new free parameter
 *  here (AFML §11.4 "do not inflate the trial space"). */
export const EDGAR_COVERAGE_WINDOW_DAYS = 30;

/** ADR-052 D2 — minimum system-wide EDGAR P/S filing count in a baseline day's
 *  trailing `EDGAR_COVERAGE_WINDOW_DAYS` window for that day to be ADMITTED to
 *  the z-baseline. Gap days (where EDGAR fetched nothing) fall below the floor
 *  and are EXCLUDED — never zero-filled, which is the trap that makes a naïve
 *  `WHERE source=edgar` filter WORSE (the 18-month EDGAR gap → forced
 *  zero-cluster-rate days → baseline depressed further; ADR-052 Context).
 *
 *  The value is pinned a-priori from EDGAR's OBSERVABLE ingest cadence, NOT
 *  from the z outcome (anti-shopping; ADR-051 Decision 5 / AFML §11.4
 *  "smallest defensible N"). EDGAR-active months run ~6.7k–11.2k P/S filings
 *  (≈ one 30d window); the 18-month gap is a hard ZERO. A floor of 500 ≈
 *  roughly one active trading day of EDGAR P/S filings present somewhere in the
 *  trailing 30d. ANY floor in [1, ~5000] separates the gap (0) from steady
 *  state (≫ 5000) IDENTICALLY — the gap is zero — so the value is robust and
 *  not outcome-fit; it additionally excludes the 1–2 partial-window
 *  coverage-transition days. The exact value is SPEC-pinned in the form_4
 *  Phase-B SPEC. */
export const EDGAR_COVERAGE_FLOOR = 500;

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
  /** GICS sector map source — defaults to 'quantlab.gics_sector_map'
   *  (s94 #1 / G1-A1). Read by `readSectorByTicker` for the per-ticker
   *  sector annotation in section #15 of the morning brief. */
  gicsSectorMapTable?: string;
}

export interface Form4InsiderDaemonResult {
  snapshot: Form4InsiderSnapshot;
  inputs: Form4InsiderInputs;
  summaryLine: string;
  /** Per-cycle GICS aggregate-panel log line per gics-sector-baseline-computation
   *  SPEC §1.3 (Step 5). Distinct from `summaryLine`: one line per composite per
   *  cycle, prefixed `[f4-aggregate]`, shape pinned by §5.5 regex G2-DAEMON-F4-1.
   *  v1 semantic per ADR-042 §"Watch-outs" Option C — see executive_departure_repository.ts
   *  ExecutiveDepartureDaemonResult.aggregateLogLine doc for the full rationale. */
  aggregateLogLine: string;
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
  /** Provenance column from `insider_trades.source` (ADR-052). Carried through
   *  so the composite can gate cluster identity to EDGAR (D1). Absent → ''. */
  source: string;
}

/** ADR-052 D2 — one (iso-day, count) row of system-wide EDGAR P/S filing
 *  volume, used to decide coverage-day admission for the z-baseline. */
interface RawEdgarPsDailyVolumeRow {
  day: string;
  n: number | string;
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
 *  the EK / XD aliases for type-graph clarity at the consumer boundary.
 *  `subIndustry` is captured at ingest but currently UNUSED by the
 *  G1-A2 brief render (v3 enhancement); the field is exposed for
 *  forensic/operator queries against the snapshot JSON. */
export type Form4InsiderSectorEntry = GicsSectorEntry;

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
  // OQ-G3-1 / s94 #8 strategy (β) persistence wiring — see G2 SPEC §2 + HANDOFF
  // S94-22. Both columns are Nullable; CH renders as `number | null` /
  // `string | null` under JSONEachRow.
  max_aggregate_z: number | string | null;
  max_aggregate_z_sector: string | null;
  // Gap #7 v2 sell-cluster F4 G3 persistence wiring (s95 #2). The four columns
  // are added by `migrate_add_sell_cluster_to_form_4_insider_snapshots.ts`.
  // Pre-migration rows resolve at cold-start defaults via DDL DEFAULTs +
  // Nullable semantics: form_4_sell_cluster_flag=0, flagged_sell_sectors_json=''
  // (parses as malformed → []), max_aggregate_z_sell=NULL,
  // max_aggregate_z_sell_sector=NULL.
  form_4_sell_cluster_flag: number | string;
  flagged_sell_sectors_json: string;
  max_aggregate_z_sell: number | string | null;
  max_aggregate_z_sell_sector: string | null;
}

export class Form4InsiderRepository {
  private readonly ch: ClickHouseClient;
  readonly insiderTradesTable: string;
  readonly sp500ConstituentsTable: string;
  readonly cikTickerMapTable: string;
  readonly candlesTable: string;
  readonly snapshotsTable: string;
  readonly gicsSectorMapTable: string;

  constructor(opts: Form4InsiderRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.insiderTradesTable = opts.insiderTradesTable ?? 'quantlab.insider_trades';
    this.sp500ConstituentsTable = opts.sp500ConstituentsTable ?? 'quantlab.sp500_constituents';
    this.cikTickerMapTable = opts.cikTickerMapTable ?? 'quantlab.cik_ticker_map';
    this.candlesTable = opts.candlesTable ?? 'quantlab.candles';
    this.snapshotsTable = opts.snapshotsTable ?? 'quantlab.form_4_insider_snapshots';
    this.gicsSectorMapTable = opts.gicsSectorMapTable ?? 'quantlab.gics_sector_map';
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
    canonicalSourceOnly: boolean = false,
  ): Promise<Map<string, InsiderTrade[]>> {
    if (tickers.length === 0) return new Map();
    const asOfStr = toIsoDateTime(asOf);
    const startStr = toIsoDateTime(
      new Date(asOf.getTime() - windowDays * 24 * 60 * 60 * 1000),
    );
    // ADR-052 D1 — the cluster/baseline path passes canonicalSourceOnly=true so
    // only EDGAR (real reporting-person CIK) rows reach the distinct-insider
    // computation. The per-ticker raw-count path keeps the default (dual-source)
    // because raw counts are identity-agnostic coverage surfaces (D3/D4).
    const sourceClause = canonicalSourceOnly
      ? `\n            AND source = {canonicalSource:String}`
      : '';
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
          dollar_amount,
          source
        FROM (
          SELECT
            issuer_ticker, issuer_cik, accession, transaction_id,
            person_cik, role_flags, transaction_code, accepted_at,
            shares, price_per_share, dollar_amount, source
          FROM ${this.insiderTradesTable} FINAL
          WHERE accepted_at >= {start:DateTime}
            AND accepted_at <= {asOf:DateTime}
            AND issuer_ticker IN ({tickers:Array(String)})
            AND transaction_code IN ({codes:Array(String)})${sourceClause}
        )
      `,
      query_params: {
        start: startStr,
        asOf: asOfStr,
        tickers: [...tickers],
        codes: [...COMPOSITE_TRANSACTION_CODES],
        canonicalSource: EDGAR_CANONICAL_SOURCE,
      },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawTradeRow>();
    return groupTradesByTicker(rows);
  }

  /**
   * ADR-052 D2 — system-wide daily count of EDGAR P/S Form 4 filings over
   * `[start, end]`, grouped by acceptance day. Used by
   * `populateSectorsForCycle` to admit only coverage-homogeneous baseline days
   * (days where EDGAR was demonstrably ingesting) and EXCLUDE the 18-month
   * EDGAR gap — never zero-fill it. Identity-independent (a simple count), so
   * it is correct to compute over the whole `insider_trades` table filtered to
   * the canonical source.
   *
   * Subquery-around-FINAL (a52c964 regression class): the FINAL + filters run
   * in the inner SELECT; `toString(toDate(...))` + the GROUP BY run outside.
   *
   * Returns Map<isoDay 'YYYY-MM-DD', count>. Days with zero EDGAR P/S filings
   * have NO map entry (the consumer treats absent as 0 — i.e. below the floor).
   */
  async readEdgarPsDailyVolume(start: Date, end: Date): Promise<Map<string, number>> {
    const startStr = toIsoDateTime(start);
    const endStr = toIsoDateTime(end);
    const q = await this.ch.query({
      query: `
        SELECT
          toString(toDate(accepted_at)) AS day,
          count() AS n
        FROM (
          SELECT accepted_at
          FROM ${this.insiderTradesTable} FINAL
          WHERE accepted_at >= {start:DateTime}
            AND accepted_at <= {end:DateTime}
            AND source = {canonicalSource:String}
            AND transaction_code IN ({codes:Array(String)})
        )
        GROUP BY day
      `,
      query_params: {
        start: startStr,
        end: endStr,
        canonicalSource: EDGAR_CANONICAL_SOURCE,
        codes: [...COMPOSITE_TRANSACTION_CODES],
      },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawEdgarPsDailyVolumeRow>();
    const out = new Map<string, number>();
    for (const r of rows) {
      if (r.day) out.set(r.day, Number(r.n));
    }
    return out;
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
   * (`src/server/gics_sector_repository_helper.ts`) — extracted at G1-A4
   * close per S94-10's rule-of-three (third byte-equal copy across F4 / EK /
   * XD lands the trigger). The helper owns the SQL + parsing; this wrapper
   * only narrows the return type to `Form4InsiderSectorEntry` for type-graph
   * clarity at the composite-API boundary.
   */
  async readSectorByTicker(
    asOf: Date,
    tickers: readonly string[],
  ): Promise<Map<string, Form4InsiderSectorEntry>> {
    return readGicsSectorByTicker(this.ch, this.gicsSectorMapTable, asOf, tickers);
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
   * Per-ticker sector resolution: G1-A2 wiring (s94 #2) — sector + sub-
   * industry resolved from `quantlab.gics_sector_map` via PIT-DESC LIMIT 1
   * BY ticker. Composite's `inputsAvailablePerTicker` now counts rows with
   * BOTH a CIK + a sector (previously structurally 0 in v1 cold-start).
   *
   * Aggregate-sector slicing: ACTIVE since s94 #9 (G2 Step 3 per
   * docs/specs/gics-sector-baseline-computation.md §6 / ADR-042 Option a) —
   * `populateSectorsForCycle(asOf)` populates `inputs.sectors` with per-day
   * rolling-30d-cluster-window cluster-rate baselines + today's 90d trades
   * for each GICS sector represented in the SP500 PIT panel. The 90d trade
   * window matches the composite's `filterTradesInWindow(..., 90)` filter
   * applied before `computeSectorClusterRate`; the 30d cluster window applies
   * internally per-ticker via `countDistinctInsidersByCode`.
   */
  async readInputsForCycle(
    asOf: Date,
    watchUniverse: readonly string[],
    _constituents: readonly string[],
  ): Promise<Form4InsiderInputs> {
    const [latestAccepted, cikByTicker, sectorByTicker, perTickerTrades, sectors] =
      await Promise.all([
        this.readLatestAcceptedAt(asOf),
        this.readCikByTicker(watchUniverse),
        this.readSectorByTicker(asOf, watchUniverse),
        this.readTradesForTickersInWindow(asOf, watchUniverse, TRADE_WINDOW_DAYS),
        this.populateSectorsForCycle(asOf),
      ]);

    const perTicker = watchUniverse.map(ticker => ({
      ticker,
      cik: cikByTicker.get(ticker) ?? '',
      sector: sectorByTicker.get(ticker)?.sector ?? null,
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
      sectors,
    };
  }

  /**
   * Compose `inputs.sectors[]` for the F4-A2 composite evaluator per
   * docs/specs/gics-sector-baseline-computation.md §1.2 + ADR-042 §4/§7/§8,
   * NORMALIZED for source provenance per ADR-052 D1/D2/D4.
   * Byte-equivalent structure to XD/EK orchestrators; differs only in that
   * F4 baseline rates come from `computeSectorClusterRate` (intrinsic 30d
   * cluster window per ticker) rather than a simple count/sectorSize, AND in
   * the two ADR-052 hygiene steps:
   *
   *   - **D1/D4 EDGAR-only cluster path:** the trailing-2y trades for the
   *     baseline are read with `canonicalSourceOnly=true`, so both the baseline
   *     and today's `s.trades` slice carry EDGAR (real reporting-person CIK)
   *     rows only. The cluster metric counts distinct insiders, which is only
   *     well-defined under the EDGAR identity (Finnhub's name-hash collides/
   *     splits people, S96-145).
   *   - **D2 coverage-homogeneous baseline:** a baseline day is ADMITTED only
   *     if EDGAR was actively ingesting in its trailing
   *     `EDGAR_COVERAGE_WINDOW_DAYS` window (system-wide EDGAR P/S volume ≥
   *     `EDGAR_COVERAGE_FLOOR`). Gap days are EXCLUDED — never zero-filled.
   *     This prevents the z=5.57 artifact: the 18-month EDGAR gap is a hard
   *     zero, and zero-filling it would drag the baseline mean down so the
   *     current value z-scores MORE extremely (ADR-052 Context). A covered day
   *     with zero sector trades still pushes rate=0 (a real observation); only
   *     NON-COVERED days are dropped.
   *
   * Workflow:
   *   1. PIT membership panel via `readSectorMembershipPanel` for the trailing
   *      2y baseline window `[asOf - 730d, asOf - 1d]` (today EXCLUDED per
   *      ADR-042 §4).
   *   2. Today's PIT constituents + per-ticker GICS timeline for strict-PIT
   *      sector attribution.
   *   3. Trailing-2y EDGAR-only {P, S} trades for today's PIT constituents via
   *      `readTradesForTickersInWindow(..., canonicalSourceOnly=true)` (ADR-052
   *      D1) + system-wide EDGAR P/S daily volume via `readEdgarPsDailyVolume`
   *      (ADR-052 D2) over `[baselineStart - EDGAR_COVERAGE_WINDOW_DAYS,
   *      baselineEnd]` (extra lookback so the earliest panel day's trailing
   *      coverage window is covered).
   *   4. Build the admitted-day set (trailing-window EDGAR P/S volume ≥ floor),
   *      bucket trades by governing sector on trade-acceptance day; build
   *      baseline2y[] from `computeSectorClusterRate(sectorTrades,
   *      memberCount, dayAsOf)` per ADMITTED panel day. The composite function
   *      groups by ticker + counts distinct insiders in the 30d cluster
   *      window ending at `dayAsOf` per ticker; per-ticker cluster_buy_flag
   *      = (distinct buyers ≥ 3); rate = cluster-tickers / memberCount.
   *   5. Today's 90d trades sliced for `s.trades` (composite re-applies
   *      `dedupeTrades` + `filterTradesToHighSignalCodes` +
   *      `filterTradesToCanonicalSource` + `filterTradesInWindow(..., 90)`
   *      defensively before its own `computeSectorClusterRate` call).
   *
   * V1 simplifications + methodology defense are identical to the XD
   * orchestrator — see the XD repository's docstring on
   * `populateSectorsForCycle`.
   */
  async populateSectorsForCycle(
    asOf: Date,
  ): Promise<Form4InsiderInputs['sectors']> {
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

    // ADR-052 D2 coverage lookback: extend the daily-volume read back an extra
    // EDGAR_COVERAGE_WINDOW_DAYS before baselineStart so the EARLIEST panel
    // day's trailing coverage window is fully observed.
    const coverageReadStart = new Date(
      baselineStart.getTime() - EDGAR_COVERAGE_WINDOW_DAYS * oneDay,
    );

    const [timeline, tradesByTicker, edgarPsDailyVolume] = await Promise.all([
      readGicsSectorTimeline(this.ch, this.gicsSectorMapTable, todayConstituents, asOf),
      // ADR-052 D1: EDGAR-only trades for the baseline + today's slice.
      this.readTradesForTickersInWindow(
        asOf, todayConstituents, BASELINE_CALENDAR_DAYS, true,
      ),
      // ADR-052 D2: system-wide EDGAR P/S daily volume for coverage admission.
      this.readEdgarPsDailyVolume(coverageReadStart, baselineEnd),
    ]);

    const sectorTradesAll = new Map<string, InsiderTrade[]>();
    for (const [ticker, trades] of tradesByTicker) {
      const tickerTimeline = timeline.get(ticker);
      if (!tickerTimeline || tickerTimeline.length === 0) continue;
      for (const tr of trades) {
        const dayIso = tr.acceptedAt.toISOString().slice(0, 10);
        const sector = findGoverningSector(tickerTimeline, dayIso);
        if (sector == null) continue;
        const arr = sectorTradesAll.get(sector) ?? [];
        arr.push(tr);
        sectorTradesAll.set(sector, arr);
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

    // ADR-052 D2 — build the set of ADMITTED baseline days (system-wide, so
    // computed once across all sectors). A panel day is admitted iff the sum of
    // system-wide EDGAR P/S filings over its trailing EDGAR_COVERAGE_WINDOW_DAYS
    // window (inclusive of the day itself) clears EDGAR_COVERAGE_FLOOR. Gap days
    // fall below the floor (the 18-month EDGAR gap is a hard zero) and are
    // EXCLUDED — they are NEVER pushed into the baseline as rate=0 (the
    // zero-fill trap that worsens the z; ADR-052 Context). Covered days with no
    // sector trades still get rate=0 below (a real zero-cluster-rate
    // observation) because they pass this gate.
    const admittedDays = computeEdgarCoverageAdmittedDays(
      panelBySectorByDay,
      edgarPsDailyVolume,
    );

    const asOfMs = asOf.getTime();
    const todayWindowStartMs = asOfMs - TRADE_WINDOW_DAYS * oneDay;
    const out: Array<{
      sector: string;
      sectorSize: number;
      trades: InsiderTrade[];
      baseline2y: number[];
      baseline2ySell: number[];
    }> = [];

    for (const sector of sortedSectors) {
      const panelDays = panelBySectorByDay.get(sector);
      const sectorTrades = sectorTradesAll.get(sector) ?? [];

      const baseline2y: number[] = [];
      const baseline2ySell: number[] = [];
      if (panelDays) {
        const sortedDays = [...panelDays.keys()].sort();
        for (const day of sortedDays) {
          const memberCount = panelDays.get(day)!;
          if (memberCount <= 0) continue;
          // ADR-052 D2 — exclude EDGAR coverage-gap days (do NOT zero-fill).
          // A non-admitted day pushes NOTHING (neither buy nor sell rate); a
          // covered day with zero sector trades still falls through and pushes
          // rate=0 below.
          if (!admittedDays.has(day)) continue;
          const dayAsOf = new Date(day + 'T23:59:59.999Z');
          // computeSectorClusterRate internally applies CLUSTER_WINDOW_DAYS=30
          // per ticker via countDistinctInsidersByCode; trades outside the
          // 30d cluster window don't affect the distinct-insider count.
          // Buy-side (F4-6) and sell-side (F4-12 v2 / S95-1) baselines are
          // computed from the SAME trade panel — the direction param selects
          // BUY_CODE vs SELL_CODE at the per-ticker distinct-insider count.
          const rateBuy = computeSectorClusterRate(
            sectorTrades, memberCount, dayAsOf, BUY_CODE,
          );
          if (rateBuy != null) baseline2y.push(rateBuy);
          const rateSell = computeSectorClusterRate(
            sectorTrades, memberCount, dayAsOf, SELL_CODE,
          );
          if (rateSell != null) baseline2ySell.push(rateSell);
        }
      }

      const todayTrades: InsiderTrade[] = [];
      for (const tr of sectorTrades) {
        const t = tr.acceptedAt.getTime();
        if (t > todayWindowStartMs && t <= asOfMs) todayTrades.push(tr);
      }

      out.push({
        sector,
        sectorSize: sectorSizeToday.get(sector) ?? 0,
        trades: todayTrades,
        baseline2y,
        baseline2ySell,
      });
    }

    return out;
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
    const flaggedSellSectorsJson = JSON.stringify(snapshot.flaggedSellSectors);
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
        // OQ-G3-1 / s94 #8 strategy (β) persistence wiring. Columns added by
        // migrate_add_max_aggregate_z_to_form_4_insider_snapshots.ts;
        // SPEC docs/specs/gics-sector-baseline-computation.md §2.
        max_aggregate_z: snapshot.maxAggregateZ,
        max_aggregate_z_sector: snapshot.maxAggregateZSector,
        // Gap #7 v2 sell-cluster F4 G3 persistence wiring (s95 #2). Columns
        // added by migrate_add_sell_cluster_to_form_4_insider_snapshots.ts.
        // Pre-migration tables silently drop these on insert (CH ignores
        // unknown column names under JSONEachRow); apply the migration to
        // surface persistence end-to-end across daemon cycles.
        form_4_sell_cluster_flag: snapshot.form4SellClusterFlag ? 1 : 0,
        flagged_sell_sectors_json: flaggedSellSectorsJson,
        max_aggregate_z_sell: snapshot.maxAggregateZSell,
        max_aggregate_z_sell_sector: snapshot.maxAggregateZSellSector,
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
          composite_version,
          max_aggregate_z,
          max_aggregate_z_sector,
          form_4_sell_cluster_flag,
          flagged_sell_sectors_json,
          max_aggregate_z_sell,
          max_aggregate_z_sell_sector
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
    // Gap #7 v2 sell-cluster F4 G3 persistence wiring (s95 #2). Pre-migration
    // rows surface as either missing keys on the row (then `?? '...'`
    // defaults below kick in) OR as the DDL DEFAULT values (UInt8=0,
    // String='', Nullable=NULL). The empty-string DEFAULT for
    // flagged_sell_sectors_json parses as malformed → []; the same
    // try/catch posture as the buy-side counterpart handles it.
    let flaggedSellSectors: ReadonlyArray<Form4InsiderFlaggedSector> = [];
    try {
      const parsed = JSON.parse(r.flagged_sell_sectors_json ?? '');
      if (Array.isArray(parsed)) {
        flaggedSellSectors = parsed as Form4InsiderFlaggedSector[];
      }
    } catch {
      flaggedSellSectors = [];
    }
    return {
      snapshotDate: new Date(Number(r.computed_at_ms)),
      lastEdgarQueryAt: lastQueryAt,
      bdSinceLastQuery: r.bd_since_last_query != null ? Number(r.bd_since_last_query) : null,
      flaggedSectors,
      form4ClusterFlag: Number(r.form_4_cluster_flag) === 1,
      // OQ-G3-1 / s94 #8 strategy (β): max-z observability now persisted via
      // the structured columns added by
      // migrate_add_max_aggregate_z_to_form_4_insider_snapshots.ts.
      // Pre-migration rows resolve as NULL on read (cold-start semantic);
      // Step 4 renderer treats null as the SPEC §1.4 cold-start branch.
      maxAggregateZ: r.max_aggregate_z != null ? Number(r.max_aggregate_z) : null,
      maxAggregateZSector: r.max_aggregate_z_sector ?? null,
      // Gap #7 v2 sell-cluster F4 G3 persistence wiring (s95 #2). DDL
      // migration `migrate_add_sell_cluster_to_form_4_insider_snapshots.ts`
      // adds the four sell-side columns; pre-migration rows resolve at
      // cold-start defaults via the DDL DEFAULTs + the Nullable semantic
      // (form_4_sell_cluster_flag=0 → false, flagged_sell_sectors_json=''
      // → [] via the malformed-JSON degrade above, max_aggregate_z_sell
      // = NULL, max_aggregate_z_sell_sector = NULL).
      flaggedSellSectors,
      form4SellClusterFlag: Number(r.form_4_sell_cluster_flag ?? 0) === 1,
      maxAggregateZSell: r.max_aggregate_z_sell != null ? Number(r.max_aggregate_z_sell) : null,
      maxAggregateZSellSector: r.max_aggregate_z_sell_sector ?? null,
      perTickerRows,
      inputsAvailableAggregate: Number(r.inputs_available_aggregate),
      inputsAvailablePerTicker: Number(r.inputs_available_per_ticker),
      version: r.composite_version as typeof FORM_4_INSIDER_COMPOSITE_VERSION,
    };
  }

  /**
   * Read a trailing window of snapshots ending at-or-before `anchor`, ASC by
   * date. Powers the composite-detail dashboard (Cycle 33 slice 2b). Read-only;
   * additive. Lightweight — selects only the two aggregate z-scores + the two
   * cluster flags + the two coverage counts (NOT the per_ticker / flagged-sector
   * JSON blobs), so a year of history is one cheap scan, no per-row JSON parse.
   *
   * Subquery-around-FINAL (S96-149 / a52c964 class): filter on the raw
   * `snapshot_date` (Date) INSIDE the subquery; `toString()` only in the outer
   * SELECT — never bind a WHERE Date range to a String alias.
   */
  async loadHistory(
    anchor: Date,
    lookbackDays: number,
  ): Promise<Form4InsiderHistoryRow[]> {
    const anchorStr = anchor.toISOString().slice(0, 10);
    const startStr = new Date(anchor.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const q = await this.ch.query({
      query: `
        SELECT
          toString(snapshot_date) AS snapshot_date,
          form_4_cluster_flag,
          form_4_sell_cluster_flag,
          max_aggregate_z,
          max_aggregate_z_sell,
          inputs_available_aggregate,
          inputs_available_per_ticker
        FROM (
          SELECT
            snapshot_date, form_4_cluster_flag, form_4_sell_cluster_flag,
            max_aggregate_z, max_aggregate_z_sell,
            inputs_available_aggregate, inputs_available_per_ticker
          FROM ${this.snapshotsTable} FINAL
          WHERE snapshot_date >= {start:Date} AND snapshot_date <= {anchor:Date}
          ORDER BY snapshot_date ASC
        )
      `,
      query_params: { start: startStr, anchor: anchorStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<{
      snapshot_date: string;
      form_4_cluster_flag: number | string;
      form_4_sell_cluster_flag: number | string;
      max_aggregate_z: number | string | null;
      max_aggregate_z_sell: number | string | null;
      inputs_available_aggregate: number | string;
      inputs_available_per_ticker: number | string;
    }>();
    return rows.map(r => ({
      date: r.snapshot_date,
      buyClusterFlag: Number(r.form_4_cluster_flag) === 1,
      sellClusterFlag: Number(r.form_4_sell_cluster_flag) === 1,
      maxAggregateZ: nullableNum(r.max_aggregate_z),
      maxAggregateZSell: nullableNum(r.max_aggregate_z_sell),
      inputsAvailableAggregate: Number(r.inputs_available_aggregate),
      inputsAvailablePerTicker: Number(r.inputs_available_per_ticker),
    }));
  }
}

/** One trailing-window snapshot row for the form_4 composite-detail dashboard
 *  (Cycle 33 slice 2b). Aggregate-layer only — per-ticker rows are not carried
 *  in history (the latest snapshot supplies the drill). */
export interface Form4InsiderHistoryRow {
  date: string;
  buyClusterFlag: boolean;
  sellClusterFlag: boolean;
  maxAggregateZ: number | null;
  maxAggregateZSell: number | null;
  inputsAvailableAggregate: number;
  inputsAvailablePerTicker: number;
}

function nullableNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
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
      // ADR-052: provenance carried through for the composite's EDGAR-only
      // cluster gate (D1) + the source-mix label (D3/D4). Absent → ''.
      source: r.source ?? '',
    };
    const arr = out.get(trade.issuerTicker) ?? [];
    arr.push(trade);
    out.set(trade.issuerTicker, arr);
  }
  return out;
}

/**
 * ADR-052 D2 — compute the set of baseline days ADMITTED to the
 * coverage-homogeneous z-baseline. A panel day `d` (iso 'YYYY-MM-DD') is
 * admitted iff the sum of system-wide EDGAR P/S filing volume over its trailing
 * `EDGAR_COVERAGE_WINDOW_DAYS` window — i.e. days in `(d - window, d]` — is
 * ≥ `EDGAR_COVERAGE_FLOOR`. This excludes EDGAR coverage-gap days (the
 * 18-month gap is a hard zero) WITHOUT zero-filling them, which is the core
 * D2 fix: a naïve EDGAR-only baseline that entered gap days as rate=0 would
 * depress the baseline mean and WORSEN the z (ADR-052 Context).
 *
 * Pure + deterministic; `edgarPsDailyVolume` is a Map<isoDay, count> (absent
 * day → 0). The candidate days are the union of all panel days across sectors.
 * Runtime is O(D × window) over distinct panel days (D ≈ 730, window = 30) →
 * trivial.
 *
 * @param panelBySectorByDay  Map<sector, Map<isoDay, memberCount>> — the panel.
 * @param edgarPsDailyVolume  Map<isoDay, count> system-wide EDGAR P/S volume,
 *                            read over `[baselineStart - window, baselineEnd]`.
 */
function computeEdgarCoverageAdmittedDays(
  panelBySectorByDay: ReadonlyMap<string, ReadonlyMap<string, number>>,
  edgarPsDailyVolume: ReadonlyMap<string, number>,
): Set<string> {
  // Union of all panel days (sector-independent admission, so de-dup first).
  const candidateDays = new Set<string>();
  for (const byDay of panelBySectorByDay.values()) {
    for (const day of byDay.keys()) candidateDays.add(day);
  }
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const admitted = new Set<string>();
  for (const day of candidateDays) {
    // Sum volume over the trailing window (d - window, d] inclusive of d.
    const dayMs = Date.parse(day + 'T00:00:00.000Z');
    if (Number.isNaN(dayMs)) continue;
    let sum = 0;
    for (let k = 0; k < EDGAR_COVERAGE_WINDOW_DAYS; k++) {
      const probe = new Date(dayMs - k * ONE_DAY_MS).toISOString().slice(0, 10);
      sum += edgarPsDailyVolume.get(probe) ?? 0;
      if (sum >= EDGAR_COVERAGE_FLOOR) break; // early-out once cleared
    }
    if (sum >= EDGAR_COVERAGE_FLOOR) admitted.add(day);
  }
  return admitted;
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

  // gics-sector-baseline-computation.md §1.3 (Step 5) per-cycle aggregate log.
  // See executive_departure_repository.ts for the tokenization rationale.
  // Gap #7 v2 sell-cluster F4 G3 (s95 #2): the F4 line extends the shared
  // shape with two extra tokens — `sell_cluster_flag=` + `max_z_sell=` —
  // mirroring the buy-side `cluster_flag=` + `max_z=` exactly. The prefix
  // is unchanged so the generic regex pin `(xd|ek|f4)-aggregate\] …
  // max_z=… cluster_flag=(true|false)` still matches as a prefix; the
  // F4-specific test G2-SELL-G3-F4-4 anchors the sell-side tokens at the
  // tail. EK/XD log lines remain buy-side-only (the canon citation for
  // symmetric sell tracking on EK/XD has NOT been argued in v2 yet).
  const aggMaxSector = snapshot.maxAggregateZSector;
  const aggMaxZ = snapshot.maxAggregateZ;
  const aggMaxToken = aggMaxSector != null && aggMaxZ != null
    ? `${aggMaxSector.replace(/\s+/g, '_')}:${aggMaxZ.toFixed(2)}`
    : 'n/a:n/a';
  const aggMaxSellSector = snapshot.maxAggregateZSellSector;
  const aggMaxZSell = snapshot.maxAggregateZSell;
  const aggMaxSellToken = aggMaxSellSector != null && aggMaxZSell != null
    ? `${aggMaxSellSector.replace(/\s+/g, '_')}:${aggMaxZSell.toFixed(2)}`
    : 'n/a:n/a';
  const aggregateLogLine =
    `[f4-aggregate] sectors_with_z=${snapshot.inputsAvailableAggregate}/11 ` +
    `floor_cleared=${snapshot.inputsAvailableAggregate}/11 ` +
    `max_z=${aggMaxToken} ` +
    `cluster_flag=${snapshot.form4ClusterFlag ? 'true' : 'false'} ` +
    `sell_cluster_flag=${snapshot.form4SellClusterFlag ? 'true' : 'false'} ` +
    `max_z_sell=${aggMaxSellToken}`;

  return { snapshot, inputs, summaryLine, aggregateLogLine };
}

/**
 * What could break this:
 *   - **ADR-052 D1/D2/D4 source-provenance normalization (S96-146).** The
 *     baseline + today's sector trades are read EDGAR-only
 *     (`readTradesForTickersInWindow(..., canonicalSourceOnly=true)`, D1); the
 *     z-baseline admits only coverage-homogeneous days
 *     (`computeEdgarCoverageAdmittedDays` gates on system-wide EDGAR P/S volume
 *     ≥ `EDGAR_COVERAGE_FLOOR` over the trailing `EDGAR_COVERAGE_WINDOW_DAYS`,
 *     D2). The per-ticker raw-count path in `readInputsForCycle` stays
 *     DUAL-SOURCE (default `canonicalSourceOnly=false`) — raw counts are
 *     identity-agnostic coverage and carry a source-mix label in the composite
 *     (D3/D4). TRAPS to avoid on any future refactor: (a) never zero-fill a
 *     gap day into the baseline — the 18-month EDGAR gap is a hard zero and
 *     zero-filling depresses the mean so the current value z-scores MORE
 *     extremely (the exact z=5.57 failure); (b) never z-score across the
 *     Finnhub/EDGAR provenance boundary — baseline + current value must be one
 *     coverage regime AND one identity scheme (AFML §11.3 stationarity).
 *   - **EDGAR_COVERAGE_FLOOR is pinned from cadence, not from the z (anti-
 *     shopping; ADR-051 Decision 5 / AFML §11.4).** Any floor in [1, ~5000]
 *     separates the gap (0) from steady state (≫5000) identically; 500 is the
 *     SPEC-pinned default. If EDGAR's steady-state P/S volume ever fell below
 *     ~5000/30d (e.g. a future partial outage), the floor would need re-pinning
 *     in the Phase-B SPEC — but it must be re-derived from observed cadence,
 *     not chosen to make a number look good.
 *   - **D5 v1-persistence deviation (documented, NOT a bug).** ADR-052 D5 says
 *     "v1 snapshots persist as historical record." But `form_4_insider_snapshots`
 *     is `ReplacingMergeTree(computed_at) ORDER BY snapshot_date` (snapshot_date
 *     only) — so when the orchestrator re-backfills v2 rows they REPLACE the v1
 *     rows for the same snapshot_date; v1 does NOT survive IN THE TABLE.
 *     Changing the ORDER BY to keep both versions would require a destructive
 *     table rebuild (operator-gated; out of scope for this slice). The real v1
 *     audit trail lives in `quantlab.health_quarantine` (the z=5.57 row,
 *     `adr_ref='ADR-052'`) + ADR-052 + git history, NOT in the snapshots table.
 *     Every NEW row is stamped `composite_version='form_4_insider_v2'` so v2 is
 *     distinguishable going forward. The table engine is intentionally left
 *     unchanged.
 *   - G1-A2 sector wiring (s94 #2): `readSectorByTicker` reads
 *     `quantlab.gics_sector_map` via PIT-DESC LIMIT 1 BY ticker. The
 *     aggregate-sector slicing remains DORMANT (`inputs.sectors` still
 *     empty) — G2 activation blocks on OQ-G2-1 (per-sector daily cluster-
 *     rate baseline-computation strategy ADR). When G2 ADR lands and the
 *     baseline approach is selected, this file populates `inputs.sectors`
 *     with the SP500 PIT constituents grouped by sector + the trailing-2y
 *     `cluster_rate_s` baseline series; the composite math is already
 *     implemented + tested in F4-A2.
 *   - `inputsAvailablePerTicker` from the composite counts rows with BOTH
 *     a CIK + a sector. With G1-A2 wiring this is now meaningful (gates
 *     on actual GICS coverage from the Wikipedia ingest). Pre-first-
 *     ingest cold start: `readSectorByTicker` returns empty map →
 *     `perTicker[].sector` is null on every row → `inputsAvailablePerTicker`
 *     is 0. The brief still uses the composer-stamped CIK-only count
 *     (`tickersWithCikCount`) for the universe-coverage line so the
 *     "0/60 with sector" cold-start does NOT poison the rendered metric.
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
 *   - F4-12 v2 sell-cluster aggregation (S95-1 composite + s95 #2 G3
 *     persistence): the composite contract emits `form4SellClusterFlag`,
 *     `flaggedSellSectors`, `maxAggregateZSell`, `maxAggregateZSellSector`
 *     end-to-end from the live daemon-cycle path AND across cycle
 *     boundaries via the four sell-side columns added by
 *     `migrate_add_sell_cluster_to_form_4_insider_snapshots.ts`. The
 *     daemon `aggregateLogLine` now extends with `sell_cluster_flag=` +
 *     `max_z_sell=` tokens (suffix of the existing shape). Pre-migration
 *     CH rows (operator has not yet applied the new ALTER) resolve to
 *     cold-start defaults at read via the DDL DEFAULTs + Nullable
 *     semantics — no daemon outage required. The brief renderer's
 *     section #15 §1.4 now emits a parallel "Sell-side cluster" panel.
 *   - EK/XD aggregate log lines stay buy-side-only. A canon-defensible
 *     argument for symmetric sell tracking on EK material events or XD
 *     executive departures has not been made; surfacing the symmetric
 *     direction on EK/XD would require its own ADR.
 */
