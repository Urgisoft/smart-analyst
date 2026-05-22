/**
 * Form 4 insider composite — Layer-0 informational input (Phase A2).
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §§2.3, 5.3, 5.4, 9.7.
 *
 * Purpose:
 *   Two scopes, both informational-only in v1 per the Phase 9+ gap-inventory
 *   README principle #5 (log first, gate after Phase B independence test):
 *
 *   1. **Per-stock** (watch-universe filtered, e.g. equity-midcap): emit
 *      `insiderBuyCount90d`, `insiderSellCount90d`, `insiderNetDollar90d`,
 *      `insiderBuyerCount90d`, `insiderSellerCount90d`, plus the cluster
 *      flags `insiderClusterBuyFlag` / `insiderClusterSellFlag`. The cluster
 *      flags fire when ≥ 3 distinct insiders (by `person_cik`) transacted in
 *      the same direction within the trailing 30-calendar-day window — same
 *      direction means same transaction code, so a 2-buy-1-sell cluster fires
 *      neither flag (F4-2 lock).
 *
 *   2. **Aggregate** (SPY-500 PIT-as-of-D, sliced by GICS sector): emit
 *      `form4ClusterFlag` when ANY sector's cluster-buy-rate (= tickers
 *      with `insiderClusterBuyFlag` in sector / sector_size) z-score
 *      against a 2y daily baseline exceeds |z| > 2 symmetrically. Per
 *      F4-6 (v1) the buy-side aggregate is load-bearing.
 *
 *      **F4-12 (v2, this slice — S95-1)**: a symmetric sell-side track
 *      runs in parallel. `form4SellClusterFlag` fires when any sector's
 *      cluster-sell-rate (= tickers with `insiderClusterSellFlag` in
 *      sector / sector_size) z-score against its OWN 2y daily baseline
 *      (`baseline2ySell`) exceeds |z| > 2 symmetrically. Lakonishok-Lee
 *      2001 §4 documents that the sell signal is ~30-50% diluted by
 *      tax/diversification/charity motives — informationally weaker than
 *      buys but non-zero. Two SEPARATE booleans + max-z sectors are
 *      emitted so downstream weighting (brief render, position sizing)
 *      can treat the two signals asymmetrically.
 *
 * Canon:
 *   - Lakonishok & Lee 2001 *Rev. Fin. Studies* §3 — open-market insider P/S
 *     filter; cluster effects strengthen the raw-trade signal.
 *   - Seyhun 1986 *J. Fin. Econ.* — raw insider-activity predictive content;
 *     foundation for the v1 raw-signal approach without CMP classifier.
 *   - Cohen, Malloy & Pomorski 2012 *J. Finance* — opportunistic-vs-routine
 *     classifier; deferred to v2 per F4-1 (requires per-insider history floor
 *     that cold-start violates).
 *
 * Design choices (SPEC §2.3 locks):
 *   - F4-1: NO routine-vs-opportunistic classifier in v1. All open-market
 *     trades count equally.
 *   - F4-2: Cluster threshold = ≥ 3 distinct insiders (by `personCik`) within
 *     30 calendar days, same direction. Distinct on insider identity, NOT on
 *     filing — a single insider with 3 separate buys counts as 1 insider.
 *   - F4-3: NO insider-role weighting in v1. `roleFlags` is stored at the
 *     ingest layer (per row) but NOT surfaced in the snapshot; v2 ADR can
 *     resurface for forensic queries.
 *   - F4-4: Open-market codes only = {"P", "S"}. Other codes (A grants, M
 *     option exercises, F payments, G gifts, etc.) are present in the ingest
 *     trade stream per S93-37 (carried-forward warning) but the composite
 *     MUST filter them out at read time. Relying on ingest-side filtering
 *     would dilute the signal with non-discretionary trading.
 *   - F4-5: Net dollar = Σ(P $ in 90d) − Σ(S $ in 90d). Sign matters.
 *   - F4-6: Aggregate counts tickers with `insiderClusterBuyFlag`, NOT raw
 *     trades. Correctly weights by issuer count not trade volume (avoids one
 *     mega-insider cluster dominating sector signal).
 *   - F4-12 (v2, S95-1): Sell-side aggregate mirrors F4-6 structurally —
 *     counts tickers with `insiderClusterSellFlag` per sector against a
 *     SEPARATE 2y baseline `baseline2ySell`. Same threshold (|z| > 2.0),
 *     same MIN_Z_BASELINE=30, same cluster window (30d), same distinct-
 *     insider threshold (3). Zero new tuned parameters per Bailey-LdP
 *     2014 selection-bias canon — the threshold is inherited unchanged
 *     from the buy-side, not refit against a validation set.
 *   - F4-7 / F4-8 / F4-9 / F4-10: ingest concerns, encoded at F4-A1.
 *   - F4-10: `acceptedAt` is the load-bearing window-membership anchor.
 *     `transactionDate` is forensic ONLY (can be 1-2bd before acceptance per
 *     17 CFR 240.16a-3). The composite is anchor-agnostic at the function
 *     boundary — the caller decides what to pass — but the SPEC mandates
 *     `acceptedAt` for windowing.
 *   - F4-11: Composite version = 'form_4_insider_v1'.
 *   - EDF-7: MIN_Z_BASELINE = 30 (matches all six prior Layer-0 composites).
 *
 * Pure-function layer:
 *   This module exposes only pure functions + type definitions. Z-score
 *   baselines are INPUTS (computed by the A4 repository from a 2y trailing
 *   panel), not computed inside this module. Same architectural separation
 *   as eight_k_classifier.ts, executive_departure.ts, etf_flow.ts,
 *   cross_asset_signals.ts, short_interest.ts.
 */

/** Composite version. Bump on any change to window length, cluster threshold,
 *  transaction-code filter, aggregator, or universe definition. Stored
 *  alongside every snapshot for backtest reproducibility. */
export const FORM_4_INSIDER_COMPOSITE_VERSION = 'form_4_insider_v1' as const;
export type Form4InsiderCompositeVersion = typeof FORM_4_INSIDER_COMPOSITE_VERSION;

// ── SPEC-pinned thresholds (re-tuning bumps composite version) ──────────────

/** Main per-stock window for net-dollar + per-direction counts (F4-5). */
export const ROLLING_WINDOW_DAYS = 90;

/** Cluster-detection window per F4-2: ≥ 3 distinct insiders within 30d. */
export const CLUSTER_WINDOW_DAYS = 30;

/** Cluster threshold per F4-2: distinct `personCik` count required. */
export const CLUSTER_INSIDER_THRESHOLD = 3;

/** Aggregate-sector cluster-rate z-threshold per F4-6 (symmetric). */
export const FORM_4_CLUSTER_Z_THRESHOLD = 2.0;

/** EDF-7: minimum baseline prints for a valid z-score. Matches the
 *  MIN_Z_BASELINE constant across all Layer-0 composites. */
export const MIN_Z_BASELINE = 30;

/** F4-4: open-market transaction codes admitted to the composite. Ingest
 *  per S93-37 stores ALL codes — this filter is enforced at READ time.
 *
 *  Byte-pinned to scripts/sec_edgar_form4_ingest.py:DEFAULT_HIGH_SIGNAL_CODES.
 *  Cross-language parity is uncaught at compile time; the constant value is
 *  pinned in the constants-sanity test (T-F4-CONST). */
export const HIGH_SIGNAL_TRANSACTION_CODES = ['P', 'S'] as const;
export type HighSignalTransactionCode = (typeof HIGH_SIGNAL_TRANSACTION_CODES)[number];

const HIGH_SIGNAL_CODE_SET = new Set<string>(HIGH_SIGNAL_TRANSACTION_CODES);

/** Transaction-code semantic: P = open-market purchase (buy direction),
 *  S = open-market sale (sell direction). Pinned for self-documentation. */
export const BUY_CODE = 'P' as const;
export const SELL_CODE = 'S' as const;

// ── Trade-level pure functions ──────────────────────────────────────────────

/** A single Form 4 transaction row as consumed by the composite. The
 *  repository assembles these from `quantlab.insider_trades`; one row per
 *  (issuerCik, accession, transactionId) tuple matching the ReplacingMergeTree
 *  ORDER BY. */
export interface InsiderTrade {
  /** EDGAR accession number, e.g. "0001234567-26-123456". One per Form 4
   *  filing. */
  accession: string;
  /** 0-based index of this transaction within the parent Form 4 filing.
   *  Per S93-40: NOT a global key — `(issuerCik, accession, transactionId)`
   *  is the unique tuple. */
  transactionId: number;
  /** Issuer (company) 10-digit zero-padded CIK. */
  issuerCik: string;
  /** Resolved issuer ticker (may be '' when the CIK→ticker map has no
   *  entry). The repository slots both XML-supplied (primary, per S93-41)
   *  and submissions-API-supplied (fallback) values here. */
  issuerTicker: string;
  /** Insider's 10-digit zero-padded CIK. Distinct from `issuerCik` per F4-9
   *  + S93-39. Cluster-distinct-count operates on this field. */
  personCik: string;
  /** UInt8 bitmask of insider roles per F4-3 / S93 watch-out:
   *  bit0=director (1), bit1=officer (2), bit2=10pct_owner (4), bit3=other (8).
   *  v1 composite does not consume this field; pass-through documentation. */
  roleFlags: number;
  /** Transaction code: 'P' (open-market purchase), 'S' (open-market sale),
   *  or other (A, M, F, G, ...). The composite filters to {P, S} on read. */
  transactionCode: string;
  /** EDGAR acceptance datetime — the load-bearing anti-leak anchor per
   *  F4-10. All rolling-window math uses this, NEVER `transactionDate`. */
  acceptedAt: Date;
  /** Shares transacted. */
  shares: number;
  /** Per-share price disclosed in the Form 4. */
  pricePerShare: number;
  /** Dollar amount = shares × pricePerShare. Pre-computed at ingest per F4-5
   *  + S93 ("dollar_amount computed at ingest layer, not deferred to CH
   *  DEFAULT") so downstream consumers don't need to recompute. The
   *  composite trusts this field as authoritative. */
  dollarAmount: number;
}

/** Deduplicate trades by `(issuerCik, accession, transactionId)`. The
 *  ReplacingMergeTree ORDER BY at storage handles physical dedupe, but a
 *  re-ingest race or upstream replay can still emit duplicate logical rows
 *  to this pure function. Same defensive posture as
 *  eight_k_classifier.dedupeEvents. */
export function dedupeTrades(trades: ReadonlyArray<InsiderTrade>): InsiderTrade[] {
  const seen = new Set<string>();
  const out: InsiderTrade[] = [];
  for (const t of trades) {
    const key = `${t.issuerCik} ${t.accession} ${t.transactionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Filter trades to {P, S} per F4-4. This is the load-bearing read-time
 *  filter that S93-37 mandates: ingest stores ALL codes; the composite
 *  enforces the open-market subset here.
 *
 *  Exact string equality — leading/trailing whitespace or case drift
 *  silently filters out. Ingest is responsible for normalizing
 *  `transaction_code` (`scripts/sec_edgar_form4_ingest.py` does so). */
export function filterTradesToHighSignalCodes(
  trades: ReadonlyArray<InsiderTrade>,
): InsiderTrade[] {
  return trades.filter((t) => HIGH_SIGNAL_CODE_SET.has(t.transactionCode));
}

/** Filter trades to a rolling window `[asOf - windowDays, asOf]` (inclusive
 *  on both boundaries per SPEC §9.7 T-F4-10).
 *  - A trade with `acceptedAt = asOf - windowDays 00:00:00` IS in window.
 *  - A trade with `acceptedAt = asOf - windowDays - 1ms` is NOT in window.
 *  - A trade with `acceptedAt > asOf` is NOT in window (F4-10 leak guard
 *    typically applied upstream at the repository; defensive here). */
export function filterTradesInWindow(
  trades: ReadonlyArray<InsiderTrade>,
  asOf: Date,
  windowDays: number,
): InsiderTrade[] {
  const asOfMs = asOf.getTime();
  const windowStartMs = asOfMs - windowDays * 24 * 60 * 60 * 1000;
  return trades.filter((t) => {
    const ms = t.acceptedAt.getTime();
    return ms >= windowStartMs && ms <= asOfMs;
  });
}

/** Count of trades with `transactionCode === code` in window. Used for
 *  `insiderBuyCount90d` (code=P) and `insiderSellCount90d` (code=S). */
export function countTradesByCode(
  trades: ReadonlyArray<InsiderTrade>,
  code: string,
  asOf: Date,
  windowDays: number = ROLLING_WINDOW_DAYS,
): number {
  return filterTradesInWindow(trades, asOf, windowDays).filter(
    (t) => t.transactionCode === code,
  ).length;
}

/** Sum of `dollarAmount` for trades with `transactionCode === code` in
 *  window. Used for the per-direction sums inside `insiderNetDollar90d`. */
export function sumDollarsByCode(
  trades: ReadonlyArray<InsiderTrade>,
  code: string,
  asOf: Date,
  windowDays: number = ROLLING_WINDOW_DAYS,
): number {
  let sum = 0;
  for (const t of filterTradesInWindow(trades, asOf, windowDays)) {
    if (t.transactionCode === code) sum += t.dollarAmount;
  }
  return sum;
}

/** Net dollar flow over the 90d window per F4-5:
 *  `Σ(buy_$ for P) − Σ(sell_$ for S)`. Sign matters; can be positive
 *  (net buying), negative (net selling), or zero. */
export function computeInsiderNetDollar(
  trades: ReadonlyArray<InsiderTrade>,
  asOf: Date,
  windowDays: number = ROLLING_WINDOW_DAYS,
): number {
  return (
    sumDollarsByCode(trades, BUY_CODE, asOf, windowDays) -
    sumDollarsByCode(trades, SELL_CODE, asOf, windowDays)
  );
}

/** Count of distinct `personCik` values among trades with `transactionCode
 *  === code` within window. Per F4-2 + F4-9: cluster distinctness is on
 *  insider identity, NOT on filing or accession. A single insider filing 3
 *  separate trades counts as 1. */
export function countDistinctInsidersByCode(
  trades: ReadonlyArray<InsiderTrade>,
  code: string,
  asOf: Date,
  windowDays: number,
): number {
  const distinct = new Set<string>();
  for (const t of filterTradesInWindow(trades, asOf, windowDays)) {
    if (t.transactionCode === code) distinct.add(t.personCik);
  }
  return distinct.size;
}

/** Cluster flag for a given direction. Fires when distinct-insider count
 *  in the cluster window meets or exceeds the threshold. Same direction
 *  semantic per F4-2 / HANDOFF watch-out: a 2-buy-1-sell mix does NOT fire
 *  either flag because each direction has < 3 distinct insiders alone. */
export function flagInsiderCluster(distinctInsiderCount: number): boolean {
  return distinctInsiderCount >= CLUSTER_INSIDER_THRESHOLD;
}

// ── Sector-aggregate pure functions ─────────────────────────────────────────

/** Sector cluster rate per F4-6 (buy-side) and F4-12 (v2 sell-side):
 *  `count(tickers in sector with insiderCluster<Direction>Flag) / sectorSize`.
 *
 *  Counts UNIQUE tickers (not raw trades) — a single mega-insider mega-cluster
 *  on one ticker contributes 1 to the numerator regardless of trade volume.
 *  Returns null when `sectorSize <= 0` (degenerate sector).
 *
 *  `direction` defaults to `BUY_CODE` ('P') so existing call sites + tests
 *  retain byte-equal behavior. Pass `SELL_CODE` ('S') for the v2 sell-side
 *  aggregate (S95-1). Direction is enforced at the type level via the
 *  `HighSignalTransactionCode` union — A/M/F/G/etc. cannot be passed. */
export function computeSectorClusterRate(
  sectorTrades: ReadonlyArray<InsiderTrade>,
  sectorSize: number,
  asOf: Date,
  direction: HighSignalTransactionCode = BUY_CODE,
): number | null {
  if (sectorSize <= 0) return null;
  // Group trades by issuerTicker, then compute per-ticker cluster flag.
  const byTicker = new Map<string, InsiderTrade[]>();
  for (const t of sectorTrades) {
    const list = byTicker.get(t.issuerTicker);
    if (list) list.push(t);
    else byTicker.set(t.issuerTicker, [t]);
  }
  let clusterTickerCount = 0;
  for (const [, tickerTrades] of byTicker) {
    const distinctInsiders = countDistinctInsidersByCode(
      tickerTrades,
      direction,
      asOf,
      CLUSTER_WINDOW_DAYS,
    );
    if (flagInsiderCluster(distinctInsiders)) clusterTickerCount++;
  }
  return clusterTickerCount / sectorSize;
}

/** Z-score = (value - mean(baseline)) / stddev(baseline).
 *  Returns null + baselineSize when baseline has fewer than MIN_Z_BASELINE
 *  prints OR stddev is degenerate (≤ 1e-12).
 *
 *  Byte-identical shape to eight_k_classifier.computeZ +
 *  executive_departure.computeZ + etf_flow.computeZ. Sample stddev (n-1) per
 *  López de Prado AFML §1.3. */
export function computeZ(
  value: number | null,
  baseline: ReadonlyArray<number>,
): { z: number | null; baselineSize: number } {
  const validBaseline = baseline.filter((b) => Number.isFinite(b));
  const baselineSize = validBaseline.length;
  if (value == null || !Number.isFinite(value) || baselineSize < MIN_Z_BASELINE) {
    return { z: null, baselineSize };
  }
  let sum = 0;
  for (const b of validBaseline) sum += b;
  const mean = sum / baselineSize;
  let sumSq = 0;
  for (const b of validBaseline) {
    const d = b - mean;
    sumSq += d * d;
  }
  const stddev = Math.sqrt(sumSq / (baselineSize - 1));
  if (stddev < 1e-12) {
    return { z: null, baselineSize };
  }
  return { z: (value - mean) / stddev, baselineSize };
}

/** `form4ClusterFlag` (buy-side) / `form4SellClusterFlag` (v2 sell-side):
 *  ANY sector with |z| > 2.0. Returns false when all sector z-scores are
 *  null (cold-start). Direction-agnostic — operates on a z array; the
 *  orchestrator calls this twice, once per direction. */
export function flagForm4Cluster(
  sectorZs: ReadonlyArray<number | null>,
): boolean {
  for (const z of sectorZs) {
    if (z != null && Math.abs(z) > FORM_4_CLUSTER_Z_THRESHOLD) return true;
  }
  return false;
}

// ── Snapshot types ──────────────────────────────────────────────────────────

/** A single ticker's row in the snapshot's per_ticker payload.
 *  Mirrors SPEC §5.5 Form4InsiderSnapshot.per_ticker_rows[i]. */
export interface Form4InsiderPerTickerRow {
  ticker: string;
  cik: string;
  sector: string | null;
  insiderBuyCount90d: number;
  insiderSellCount90d: number;
  insiderBuyerCount90d: number;
  insiderSellerCount90d: number;
  insiderNetDollar90d: number;
  insiderClusterBuyFlag: boolean;
  insiderClusterSellFlag: boolean;
}

/** A flagged sector row — only emitted for sectors with |z| > 2.0. */
export interface Form4InsiderFlaggedSector {
  sector: string;
  sectorSize: number;
  clusterRateT: number;
  z: number;
  baselineSize: number;
}

/** Inputs to the composite evaluator. The repository (A4) assembles these
 *  from CH reads of `insider_trades` + `cik_ticker_map` + `sp500_constituents`
 *  PIT + the GICS-sector mapping + per-sector trailing-2y daily cluster-rate
 *  panels. */
export interface Form4InsiderInputs {
  asOf: Date;

  /** Wall-clock UTC of the most-recent EDGAR poll. Null when ingest has
   *  never run. */
  lastEdgarQueryAt: Date | null;

  /** Business days between lastEdgarQueryAt and asOf. Used as a staleness
   *  indicator in the brief (healthy = 0-3; 4+ means ingest is stale). */
  bdSinceLastQuery: number | null;

  /** Per-ticker inputs for the watch universe (e.g. equity_midcap).
   *  `trades` is the FULL trailing-90d trade panel for the ticker (any
   *  transaction code admitted; the composite filters to {P, S} internally
   *  per F4-4 defensive read). */
  perTicker: ReadonlyArray<{
    ticker: string;
    cik: string;
    sector: string | null;
    trades: ReadonlyArray<InsiderTrade>;
  }>;

  /** Sector-aggregate inputs. One entry per GICS sector represented in the
   *  SPY-500 constituent panel as-of asOf. */
  sectors: ReadonlyArray<{
    sector: string;
    /** Number of SPY-500 constituents in this sector at asOf. */
    sectorSize: number;
    /** All trailing-90d trades for tickers in this sector. Any transaction
     *  code admitted; the composite filters to {P, S} internally. */
    trades: ReadonlyArray<InsiderTrade>;
    /** Trailing 2y daily panel of per-day cluster-BUY-rate (one value per
     *  business day in the trailing 2y window). Used for the buy-side
     *  z-score baseline per F4-6. */
    baseline2y: ReadonlyArray<number>;
    /** Trailing 2y daily panel of per-day cluster-SELL-rate (one value
     *  per business day in the trailing 2y window). Used for the v2
     *  sell-side z-score baseline per F4-12 (S95-1). Independent of
     *  `baseline2y` — the two metrics have different historical
     *  distributions (sell-cluster events are typically more frequent
     *  than buy-cluster events per Lakonishok-Lee 2001 §4). Pass `[]`
     *  for cold-start / pre-G2 wiring; the composite handles a
     *  short/empty baseline via the MIN_Z_BASELINE=30 floor. */
    baseline2ySell: ReadonlyArray<number>;
  }>;
}

/** Output snapshot — mirrors SPEC §5.5 + CH column shape (see A3 migration). */
export interface Form4InsiderSnapshot {
  snapshotDate: Date;
  lastEdgarQueryAt: Date | null;
  bdSinceLastQuery: number | null;

  flaggedSectors: ReadonlyArray<Form4InsiderFlaggedSector>;
  form4ClusterFlag: boolean;

  /** Signed z of the sector with max |z| across all sectors with non-null z.
   *  Null when all sector z's are null (cold-start). Per ADR-042 §1 Decision §1
   *  + SPEC docs/specs/gics-sector-baseline-computation.md §2; consumed by the
   *  brief renderer's §1.4 "No sectors flagged today" branch. */
  maxAggregateZ: number | null;
  /** Sector name with max |z|. Null when all z's are null. Ties broken
   *  lexicographically (earlier sector name wins; deterministic across runs). */
  maxAggregateZSector: string | null;

  /** v2 sell-side aggregate, mirror of `flaggedSectors` for the
   *  cluster-SELL-rate track. F4-12 (S95-1). Empty when no sector's
   *  sell-side |z| > 2.0. */
  flaggedSellSectors: ReadonlyArray<Form4InsiderFlaggedSector>;
  /** v2 sell-side `form4ClusterFlag` mirror — fires when ANY sector's
   *  sell-side |z| > 2.0. Independent of `form4ClusterFlag`; both can fire
   *  simultaneously (concurrent buy- + sell-side anomalies) or in
   *  isolation. */
  form4SellClusterFlag: boolean;
  /** v2 sell-side `maxAggregateZ` mirror. Null when all sell-side z's are
   *  null (cold-start OR pre-G2 wiring where `baseline2ySell` is empty). */
  maxAggregateZSell: number | null;
  /** v2 sell-side `maxAggregateZSector` mirror. Same lexicographic
   *  tie-break as the buy-side counterpart. */
  maxAggregateZSellSector: string | null;

  perTickerRows: ReadonlyArray<Form4InsiderPerTickerRow>;

  inputsAvailableAggregate: number;
  inputsAvailablePerTicker: number;
  version: Form4InsiderCompositeVersion;
}

// ── Composite orchestrator ──────────────────────────────────────────────────

/** Evaluate the Form 4 insider composite end-to-end.
 *
 *  Steps:
 *    1. Per-ticker: dedupe + code-filter + window-filter trades; derive
 *       per-direction counts, distinct-insider counts, net dollar, and the
 *       30d cluster flags (per direction).
 *    2. Sector-aggregate: per sector, compute cluster_rate_t (tickers with
 *       buy-cluster-flag fired / sector_size) and z-score against the
 *       trailing 2y baseline; emit a flaggedSectors row when |z| > 2.0.
 *    3. Compose into the snapshot shape.
 *
 *  No I/O. No side effects. Re-runnable with identical inputs.
 */
export function evaluateForm4InsiderComposite(
  inputs: Form4InsiderInputs,
): Form4InsiderSnapshot {
  // Per-ticker layer
  const perTickerRows: Form4InsiderPerTickerRow[] = [];
  let inputsAvailablePerTicker = 0;
  for (const row of inputs.perTicker) {
    const deduped = dedupeTrades(row.trades);
    const psFiltered = filterTradesToHighSignalCodes(deduped);

    const insiderBuyCount90d = countTradesByCode(psFiltered, BUY_CODE, inputs.asOf);
    const insiderSellCount90d = countTradesByCode(psFiltered, SELL_CODE, inputs.asOf);
    const insiderBuyerCount90d = countDistinctInsidersByCode(
      psFiltered, BUY_CODE, inputs.asOf, ROLLING_WINDOW_DAYS,
    );
    const insiderSellerCount90d = countDistinctInsidersByCode(
      psFiltered, SELL_CODE, inputs.asOf, ROLLING_WINDOW_DAYS,
    );
    const insiderNetDollar90d = computeInsiderNetDollar(psFiltered, inputs.asOf);

    const distinctBuyers30d = countDistinctInsidersByCode(
      psFiltered, BUY_CODE, inputs.asOf, CLUSTER_WINDOW_DAYS,
    );
    const distinctSellers30d = countDistinctInsidersByCode(
      psFiltered, SELL_CODE, inputs.asOf, CLUSTER_WINDOW_DAYS,
    );

    const insiderClusterBuyFlag = flagInsiderCluster(distinctBuyers30d);
    const insiderClusterSellFlag = flagInsiderCluster(distinctSellers30d);

    if (row.sector != null && row.cik !== '') inputsAvailablePerTicker++;

    perTickerRows.push({
      ticker: row.ticker,
      cik: row.cik,
      sector: row.sector,
      insiderBuyCount90d,
      insiderSellCount90d,
      insiderBuyerCount90d,
      insiderSellerCount90d,
      insiderNetDollar90d,
      insiderClusterBuyFlag,
      insiderClusterSellFlag,
    });
  }

  // Sector-aggregate layer — buy-side (F4-6) and sell-side (F4-12 v2)
  // run in parallel; each direction has its own baseline + z + flagged-set.
  const flaggedSectors: Form4InsiderFlaggedSector[] = [];
  const flaggedSellSectors: Form4InsiderFlaggedSector[] = [];
  const sectorZs: (number | null)[] = [];
  const sectorSellZs: (number | null)[] = [];
  let inputsAvailableAggregate = 0;
  let maxAbsZ = -Infinity;
  let maxAggregateZ: number | null = null;
  let maxAggregateZSector: string | null = null;
  let maxAbsZSell = -Infinity;
  let maxAggregateZSell: number | null = null;
  let maxAggregateZSellSector: string | null = null;
  for (const s of inputs.sectors) {
    const dedupedSectorTrades = dedupeTrades(s.trades);
    const psFilteredSectorTrades = filterTradesToHighSignalCodes(dedupedSectorTrades);
    const inWindowSectorTrades = filterTradesInWindow(
      psFilteredSectorTrades, inputs.asOf, ROLLING_WINDOW_DAYS,
    );

    const rateBuy = computeSectorClusterRate(
      inWindowSectorTrades, s.sectorSize, inputs.asOf, BUY_CODE,
    );
    const rateSell = computeSectorClusterRate(
      inWindowSectorTrades, s.sectorSize, inputs.asOf, SELL_CODE,
    );
    const { z, baselineSize } = computeZ(rateBuy, s.baseline2y);
    const { z: zSell, baselineSize: baselineSizeSell } = computeZ(
      rateSell, s.baseline2ySell,
    );
    sectorZs.push(z);
    sectorSellZs.push(zSell);
    if (s.sectorSize > 0) inputsAvailableAggregate++;
    if (z != null) {
      const absZ = Math.abs(z);
      // Tie-break: lexicographically earlier sector name wins. Order-independent
      // across permutations of inputs.sectors per SPEC §5.2 MAXZ-*-4.
      if (
        absZ > maxAbsZ ||
        (absZ === maxAbsZ && (maxAggregateZSector == null || s.sector < maxAggregateZSector))
      ) {
        maxAbsZ = absZ;
        maxAggregateZ = z;
        maxAggregateZSector = s.sector;
      }
    }
    if (zSell != null) {
      const absZSell = Math.abs(zSell);
      if (
        absZSell > maxAbsZSell ||
        (absZSell === maxAbsZSell
          && (maxAggregateZSellSector == null || s.sector < maxAggregateZSellSector))
      ) {
        maxAbsZSell = absZSell;
        maxAggregateZSell = zSell;
        maxAggregateZSellSector = s.sector;
      }
    }
    if (z != null && Math.abs(z) > FORM_4_CLUSTER_Z_THRESHOLD && rateBuy != null) {
      flaggedSectors.push({
        sector: s.sector,
        sectorSize: s.sectorSize,
        clusterRateT: rateBuy,
        z,
        baselineSize,
      });
    }
    if (zSell != null && Math.abs(zSell) > FORM_4_CLUSTER_Z_THRESHOLD && rateSell != null) {
      flaggedSellSectors.push({
        sector: s.sector,
        sectorSize: s.sectorSize,
        clusterRateT: rateSell,
        z: zSell,
        baselineSize: baselineSizeSell,
      });
    }
  }
  const form4ClusterFlag = flagForm4Cluster(sectorZs);
  const form4SellClusterFlag = flagForm4Cluster(sectorSellZs);

  return {
    snapshotDate: inputs.asOf,
    lastEdgarQueryAt: inputs.lastEdgarQueryAt,
    bdSinceLastQuery: inputs.bdSinceLastQuery,

    flaggedSectors,
    form4ClusterFlag,
    maxAggregateZ,
    maxAggregateZSector,

    flaggedSellSectors,
    form4SellClusterFlag,
    maxAggregateZSell,
    maxAggregateZSellSector,

    perTickerRows,

    inputsAvailableAggregate,
    inputsAvailablePerTicker,
    version: FORM_4_INSIDER_COMPOSITE_VERSION,
  };
}

/**
 * What could break this:
 *   - **Cross-language drift on the {P, S} filter (S93-37 load-bearing).**
 *     Python ingest's `DEFAULT_HIGH_SIGNAL_CODES = ("P", "S")` and this
 *     module's `HIGH_SIGNAL_TRANSACTION_CODES` are conceptually byte-pinned
 *     but there's no compile-time link. If a future v2 widens the code set
 *     (e.g., adds "M" exercises) without changing this constant, the
 *     composite silently filters them out at read — even though ingest
 *     stores them. The constants-sanity test pins both values to {P, S}
 *     for v1; a v2 widening MUST update both ends + the test.
 *   - **Same-direction cluster semantic (F4-2 + HANDOFF watch-out).** A
 *     2-buy-1-sell mix has < 3 distinct insiders in each direction alone,
 *     so neither `insiderClusterBuyFlag` nor `insiderClusterSellFlag`
 *     fires. A reader expecting "any 3 insiders in 30d" semantic would be
 *     surprised. Per F4-2 lock: direction matters because mixed clusters
 *     don't carry directional conviction.
 *   - **Distinct on personCik, NOT on accession (F4-2 + S93-39 + HANDOFF
 *     watch-out).** A single insider filing 3 separate buys counts as 1.
 *     Person CIK ≠ Issuer CIK ≠ filing accession. The natural-person-CIK
 *     resolution at ingest is load-bearing for this semantic.
 *   - **Two-track aggregate (F4-6 buy + F4-12 v2 sell).** `form4ClusterFlag`
 *     fires on concentrated insider BUYING activity (bullish surprise);
 *     `form4SellClusterFlag` (S95-1) fires on concentrated SELLING activity.
 *     The two flags are INDEPENDENT — both can fire simultaneously, neither
 *     can fire, or either can fire alone. Downstream consumers (brief
 *     render, position sizing) should weight the sell signal asymmetrically
 *     per Lakonishok-Lee 2001 §4 (sell signal is ~30-50% diluted by
 *     tax/diversification/charity motives — informationally weaker than
 *     buys but non-zero). The composite intentionally does NOT collapse
 *     the two tracks into a single "any anomalous activity" flag because
 *     the information content differs.
 *   - **Sell-side baseline is INDEPENDENT of buy-side baseline.**
 *     `baseline2y` and `baseline2ySell` track different historical
 *     distributions; a sector's typical sell-cluster-rate is typically
 *     higher than its typical buy-cluster-rate (sells are more frequent
 *     in steady-state). Mixing the two baselines would distort the z-test
 *     in either direction.
 *   - **Off-set codes silently filtered at composite layer.** A regression
 *     that read the raw insider_trades stream WITHOUT calling
 *     `filterTradesToHighSignalCodes` first would dilute counts with
 *     grants, option exercises, gifts, etc. The orchestrator enforces the
 *     filter; direct callers of `countTradesByCode` etc. must filter
 *     themselves OR pass an already-filtered slice.
 *   - **Window inclusivity on both ends.** A trade at `acceptedAt = asOf -
 *     90d 00:00:00.000Z` IS in window; at `asOf - 90d - 1ms` is NOT.
 *     Repository-layer leak guards (F4-10) typically run before this; the
 *     composite is defense-in-depth.
 *   - **`acceptedAt` is the load-bearing anchor (F4-10).** Using
 *     `transactionDate` for windowing would inject look-ahead leakage —
 *     insiders have 2 business days to file post-trade per 17 CFR
 *     240.16a-3. The composite trusts the caller to pass `acceptedAt`;
 *     downstream verification is at the repository layer.
 *   - **Cold-start cascade in aggregate.** A single missing-baseline sector
 *     forces its z to null but `form4ClusterFlag` still fires if any OTHER
 *     sector exceeds threshold. Mirrors EK + gap #8 + gap #9 posture.
 *     Operator sees the cold-start via `inputsAvailableAggregate < sector
 *     count` in the snapshot.
 *   - **`dollarAmount` trusted as-is.** F4-5 pre-computes `shares ×
 *     pricePerShare` at ingest per S93. If a future ingest regression sets
 *     `dollarAmount = 0` while preserving shares + price, net-dollar math
 *     silently zeroes. Round-trip tests at the ingest layer pin this; the
 *     composite is downstream.
 *   - **`roleFlags` pass-through only.** v1 weights each role at 1.0 per
 *     F4-3; the field is on `InsiderTrade` for forensic completeness but
 *     not consumed by any composite formula. v2 ADR can resurface for
 *     CEO-weighted variants.
 */
