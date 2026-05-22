/**
 * ETF-flow composite — Layer-0 informational input (Phase A2).
 *
 * SPEC: docs/specs/etf-flow-monitoring.md §§2, 5, 9.1.
 *
 * Purpose:
 *   Two scopes, both informational-only in v1 per the Phase 9+ gap-inventory
 *   README principle #5 (log first, gate after Phase B independence test):
 *
 *   1. **Per-ETF** (21-ticker v1 universe): emit a 20-business-day cumulative
 *      net-flow figure (in shares + in dollars + as % of AUM) for each ETF.
 *      Emit a `flow_z` (z-score of % of AUM flow vs trailing 1y daily baseline)
 *      and a `divergence_flag` (binary) when 20bd flow and 20bd return have
 *      opposite signs AND both |z| > 1.
 *
 *   2. **Aggregate**: emit `sector_flow_dispersion` (cross-sectional stddev of
 *      the 11 SPDR sector ETF flow z-scores) and `aggregate_risk_on_flow`
 *      (mean of broad-index ETF flow z-scores across SPY+IVV+VOO+QQQ+IWM+DIA).
 *      Emit `aggregate_flow_stress_flag` when either dispersion > 2.0 OR
 *      |risk_on_flow| > 2.0.
 *
 * Canon:
 *   Ben-David, Franzoni, Moussawi 2018 *J. Finance* 73(6) §3 — construct ETF
 *     flows from the CRSP shares-outstanding panel: Δ shares × close per day.
 *     The methodology in §5 replicates this construction at the daily horizon
 *     with yfinance shares-outstanding as the free-data equivalent of CRSP.
 *   Brown, Davies, Ringgenberg 2021 *RFS* 34(7) — tests flow-based
 *     predictability of underlying constituent returns at 5-20 day horizons.
 *   Stambaugh 2014 *J. Finance* — distinguishes informative low-frequency
 *     "trends" from non-informative "noise"; supports the 20bd horizon.
 *
 * Design choices (SPEC §2 locks):
 *   - F-1 20bd cumulative flow, decomposed into shares + dollars + % of AUM.
 *     Sum-of-daily attribution per BFM 2018 footnote 7 (NOT the simpler
 *     (shares_t - shares_{t-20bd}) × close_t which mis-attributes to the
 *     end-of-window price).
 *   - F-2 1y daily trailing baseline + MIN_Z_BASELINE = 30 prints floor.
 *     Matches the constant across cross_asset / sector_rotation / short_interest
 *     / executive_departure.
 *   - F-3 % of AUM (not absolute $) as the load-bearing per-ETF measure.
 *     Cross-ETF comparable; canon-load-bearing per BFM 2018 lagged-AUM
 *     normalization.
 *   - F-4 divergence rule: |flow_z| > 1 AND |return_z_20bd| > 1 AND opposite
 *     signs. NO calibrated threshold (canon: AFML §11, Bailey-Lopez de Prado
 *     2014, Harvey-Liu-Zhu 2016 reject in-sample tuning).
 *   - F-5 sector_flow_dispersion = stddev of 11 SPDR sector ETF flow z's;
 *     >2.0 threshold matches per-ETF |z|>2 thresholds. POPULATION stddev
 *     (divide by N, not N-1): the 11 sectors are the population, not a
 *     sample from one.
 *   - F-6 aggregate_risk_on_flow = mean of 6 broad-index ETF flow z's;
 *     |z|>2 threshold.
 *   - F-7 aggregate_flow_stress_flag = (dispersion > 2.0) OR
 *     (|risk_on_flow| > 2.0). OR-aggregation matches cross-asset / sector-
 *     rotation flag posture.
 *   - F-9 cold-start: any constituent's flow_z = null forces the aggregate to
 *     null + flag false. Matches the four prior composites' cold-start pattern.
 *
 * Pure-function layer:
 *   This module exposes only pure functions + type definitions. The 21-day
 *   shares/close panel and the 1y baselines are INPUTS (computed/assembled by
 *   the A4 repository from quantlab.etf_shares_outstanding), not computed
 *   inside this module. Same architectural separation as short_interest.ts,
 *   cross_asset_signals.ts, and executive_departure.ts.
 */

import {
  compareEtfFlowPanels,
  summarizeDivergences,
  type EtfFlowCrossValidationSummary,
  type EtfFlowPrimaryPoint,
  type EtfFlowSecondaryPoint,
} from './etf_flow_cross_validation.js';

export type {
  EtfFlowCrossValidationSummary,
  EtfFlowPrimaryPoint,
  EtfFlowSecondaryPoint,
};

/** Composite version. Bump on any change to thresholds, universe membership,
 *  window length, baseline construction, or flag-derivation logic. Stored
 *  alongside every snapshot for backtest reproducibility (F-10). */
export const ETF_FLOW_COMPOSITE_VERSION = 'etf_flow_v1' as const;
export type EtfFlowCompositeVersion = typeof ETF_FLOW_COMPOSITE_VERSION;

/** Default operator-facing label for the secondary source when `EtfFlowInputs.
 *  secondarySourceLabel` is not specified. Matches the most-likely first-
 *  cut wiring (issuer-supplied CSVs — see Gap #9 v2 SPEC OQ resolution). */
export const DEFAULT_SECONDARY_SOURCE_LABEL = 'issuer-csv';

// ── SPEC §2 / §5-pinned constants (re-tuning bumps composite version) ──────

/** F-1: cumulative-flow window in business days. */
export const FLOW_WINDOW_BD = 20;

/** F-2 / F-14: minimum baseline prints for a valid z-score. Matches the
 *  MIN_Z_BASELINE constant across all Layer-0 composites. */
export const MIN_Z_BASELINE = 30;

/** F-4: per-ETF divergence symmetric threshold on |flow_z| AND |return_z|. */
export const DIVERGENCE_Z_THRESHOLD = 1.0;

/** F-5: aggregate sector_flow_dispersion threshold for "active rotation". */
export const SECTOR_FLOW_DISPERSION_THRESHOLD = 2.0;

/** F-6: aggregate |risk_on_flow| symmetric threshold for "broad-flow stress". */
export const AGGREGATE_RISK_ON_FLOW_Z_THRESHOLD = 2.0;

/** F-CADENCE: business-days-since-last-share-update threshold above which a
 *  given ETF's flow is considered stale. */
export const STALENESS_BD_THRESHOLD = 3;

/** F-20 helper: per-ETF |flow_z| threshold for inclusion in `flagged_etfs`. */
export const FLAGGED_ETFS_ABS_Z_THRESHOLD = 2.0;

// ── F-UNIVERSE: v1 21-ETF universe per SPEC §2 row F-UNIVERSE ──────────────
// Matches scripts/etf_flow_ingest.py:54-62 by name. The composite reads `group`
// off the input row — but downstream consumers (A4 repository) need to know
// which tickers belong to which group to do per-group aggregation. Hence the
// constants live here as the single source of truth.

export const BROAD_INDEX_ETFS = ['SPY', 'IVV', 'VOO', 'QQQ', 'IWM', 'DIA'] as const;
export const SPDR_SECTOR_ETFS = [
  'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP',
  'XLU', 'XLI', 'XLB', 'XLRE', 'XLC',
] as const;
export const STYLE_RISK_ETFS = ['HYG', 'JNK', 'TLT', 'GLD'] as const;
export const ETF_UNIVERSE = [
  ...BROAD_INDEX_ETFS,
  ...SPDR_SECTOR_ETFS,
  ...STYLE_RISK_ETFS,
] as const;

export type EtfGroup = 'broad' | 'sector' | 'style';

const BROAD_SET = new Set<string>(BROAD_INDEX_ETFS);
const SECTOR_SET = new Set<string>(SPDR_SECTOR_ETFS);
const STYLE_SET = new Set<string>(STYLE_RISK_ETFS);

/** Resolve an ETF ticker to its F-UNIVERSE group. Returns null for tickers
 *  outside the v1 universe; the orchestrator passes group through unchanged
 *  when this is non-null, otherwise the row is annotated null. */
export function resolveEtfGroup(ticker: string): EtfGroup | null {
  if (BROAD_SET.has(ticker)) return 'broad';
  if (SECTOR_SET.has(ticker)) return 'sector';
  if (STYLE_SET.has(ticker)) return 'style';
  return null;
}

// ── Per-ETF pure functions ─────────────────────────────────────────────────

/** F-1 (a): 20bd flow in shares = shares_t - shares_{t-20bd}.
 *  Inputs sourced from the post-carry-forward panel at the repository layer
 *  (per F-CADENCE, missing days inherit the prior-day value). */
export function computeFlowShares20bd(
  sharesT: number,
  sharesTMinus20bd: number,
): number {
  return sharesT - sharesTMinus20bd;
}

/** F-1 (b): 20bd flow in dollars = sum over i in [D-19bd, D] of
 *  (shares_i - shares_{i-1}) × close_i. Per BFM 2018 footnote 7: this
 *  attribution-correct sum (price at which flow was created) differs from
 *  the simpler `(shares_t - shares_{t-20bd}) × close_t` when shares-changes
 *  are concentrated at one end of the window.
 *
 *  Input shape: a 21-element panel of shares + closes, where index 0 = D-20bd
 *  and index 20 = D. The function consumes 21 shares prints (for the 20 daily
 *  differences) and 20 closes (closes[1..20] = close_i for i in [D-19bd, D]).
 *
 *  Throws when either array length is wrong — fail-loud per Vector Core canon
 *  (silent length-mismatch would mis-attribute flow to wrong days). */
export function computeFlowDollar20bd(
  shares21: ReadonlyArray<number>,
  closes21: ReadonlyArray<number>,
): number {
  if (shares21.length !== FLOW_WINDOW_BD + 1) {
    throw new Error(
      `computeFlowDollar20bd: shares array must have ${FLOW_WINDOW_BD + 1} elements ` +
      `(D-${FLOW_WINDOW_BD}bd through D inclusive), got ${shares21.length}`,
    );
  }
  if (closes21.length !== FLOW_WINDOW_BD + 1) {
    throw new Error(
      `computeFlowDollar20bd: closes array must have ${FLOW_WINDOW_BD + 1} elements, ` +
      `got ${closes21.length}`,
    );
  }
  let sum = 0;
  // Iterate i from 1 to 20 inclusive (the 20 daily flows in the window).
  // i=0 corresponds to D-20bd which has no preceding day in the panel; the
  // first attributed daily flow is at i=1 (D-19bd).
  for (let i = 1; i <= FLOW_WINDOW_BD; i++) {
    const dailyShareChange = shares21[i] - shares21[i - 1];
    sum += dailyShareChange * closes21[i];
  }
  return sum;
}

/** F-1 (c): flow as % of AUM = flow_dollar_20bd / (shares_t × close_t).
 *  Returns null when AUM = 0 (degenerate; shouldn't occur for the v1 universe
 *  but defensive against bad data). */
export function computeFlowPctAum(
  flowDollar20bd: number,
  sharesT: number,
  closeT: number,
): number | null {
  const aum = sharesT * closeT;
  if (aum === 0) return null;
  return flowDollar20bd / aum;
}

/** 20bd simple return = close_t / close_{t-20bd} - 1.
 *  Returns null when the prior close is 0 (defensive). */
export function computeReturn20bd(
  closeT: number,
  closeTMinus20bd: number,
): number | null {
  if (closeTMinus20bd === 0) return null;
  return closeT / closeTMinus20bd - 1;
}

/** Z-score = (value - mean(baseline)) / stddev(baseline).
 *  Returns null + baselineSize when baseline has fewer than MIN_Z_BASELINE
 *  prints OR stddev is degenerate (all-identical baseline).
 *
 *  Identical shape to short_interest.ts:computeZ / executive_departure.ts:
 *  computeZ. Sample stddev (n-1) per López de Prado AFML §1.3. Sub-1e-12
 *  stddev treated as degenerate to avoid FP-noise-driven spurious z-scores.
 */
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

/** F-4: divergence flag fires iff
 *   - both z-scores are non-null,
 *   - |flow_z| > 1 AND |return_z_20bd| > 1,
 *   - sign(flow_z) ≠ sign(return_z_20bd) (opposite directions).
 *  Returns false when either z is null (cold-start short-circuit per T-EF-10). */
export function flagDivergence(
  flowZ: number | null,
  returnZ20bd: number | null,
): boolean {
  if (flowZ == null || returnZ20bd == null) return false;
  if (Math.abs(flowZ) <= DIVERGENCE_Z_THRESHOLD) return false;
  if (Math.abs(returnZ20bd) <= DIVERGENCE_Z_THRESHOLD) return false;
  return Math.sign(flowZ) !== Math.sign(returnZ20bd);
}

// ── Aggregate pure functions ───────────────────────────────────────────────

/** F-5: sector_flow_dispersion = stddev across 11 SPDR sector ETF flow z's.
 *  Per F-9 cold-start: returns null if ANY input is null. Uses POPULATION
 *  stddev (divide by N, not N-1) — the 11 sector ETFs ARE the population at
 *  this snapshot date, not a sample from a larger population, so the unbiased-
 *  estimator (n-1) correction is conceptually inappropriate.
 *
 *  Empty input (zero ETFs) returns null. Single ETF returns 0 (cross-section
 *  of one has zero spread by definition). */
export function computeSectorFlowDispersion(
  zs: ReadonlyArray<number | null>,
): number | null {
  if (zs.length === 0) return null;
  for (const z of zs) {
    if (z == null || !Number.isFinite(z)) return null;
  }
  const validZs = zs as ReadonlyArray<number>;
  if (validZs.length === 1) return 0;
  let sum = 0;
  for (const z of validZs) sum += z;
  const mean = sum / validZs.length;
  let sumSq = 0;
  for (const z of validZs) {
    const d = z - mean;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / validZs.length);
}

/** F-6: aggregate_risk_on_flow = arithmetic mean across 6 broad-index ETF
 *  flow z's. Per F-9 cold-start: returns null if ANY input is null. */
export function computeAggregateRiskOnFlow(
  zs: ReadonlyArray<number | null>,
): number | null {
  if (zs.length === 0) return null;
  for (const z of zs) {
    if (z == null || !Number.isFinite(z)) return null;
  }
  const validZs = zs as ReadonlyArray<number>;
  let sum = 0;
  for (const z of validZs) sum += z;
  return sum / validZs.length;
}

/** F-7: aggregate_flow_stress_flag = (sector_flow_dispersion > 2.0) OR
 *  (|aggregate_risk_on_flow| > 2.0). Returns false when both inputs are null
 *  (cold-start; matches the four prior composites' cold-start posture). */
export function flagAggregateFlowStress(
  sectorFlowDispersion: number | null,
  aggregateRiskOnFlow: number | null,
): boolean {
  if (sectorFlowDispersion != null && sectorFlowDispersion > SECTOR_FLOW_DISPERSION_THRESHOLD) {
    return true;
  }
  if (
    aggregateRiskOnFlow != null &&
    Math.abs(aggregateRiskOnFlow) > AGGREGATE_RISK_ON_FLOW_Z_THRESHOLD
  ) {
    return true;
  }
  return false;
}

// ── Snapshot types ─────────────────────────────────────────────────────────

/** A single ETF's row in the snapshot's per_etf_rows payload.
 *  Mirrors SPEC §5.3 EtfFlowSnapshot.per_etf_rows[i]. */
export interface EtfFlowPerEtfRow {
  ticker: string;
  group: EtfGroup | null;
  sharesOutstandingT: number;
  closeT: number;
  aumT: number;
  flowShares20bd: number;
  flowDollar20bd: number;
  flowPctAumT: number | null;
  flowZ: number | null;
  return20bd: number | null;
  returnZ20bd: number | null;
  divergenceFlag: boolean;
  bdSinceShareUpdate: number;
}

/** A flagged-ETF row — emitted for ETFs with divergence_flag=true OR |flow_z|>2.
 *  Per SPEC §5.3 `flagged_etfs` field; A5 brief panel renders this list. */
export interface EtfFlowFlaggedEtf {
  ticker: string;
  flowZ: number;
  returnZ20bd: number | null;
  flowPctAumT: number;
  divergenceFlag: boolean;
}

/** Per-ETF inputs to the composite evaluator. The repository (A4) assembles
 *  these from CH reads of quantlab.etf_shares_outstanding + the trailing 1y
 *  baseline panel. */
export interface EtfFlowPerEtfInput {
  ticker: string;
  /** 21-element shares panel: index 0 = D-20bd, ..., index 20 = D.
   *  Carry-forward (F-CADENCE) applied by repository before this input. */
  shares21: ReadonlyArray<number>;
  /** 21-element closes panel, same indexing as shares21. */
  closes21: ReadonlyArray<number>;
  /** Trailing 1y daily panel of flow_pct_aum values; used as the z-score
   *  baseline per F-2. */
  baseline1yFlowPctAum: ReadonlyArray<number>;
  /** Trailing 1y daily panel of return_20bd values; used as the z-score
   *  baseline for return_z_20bd per F-2. */
  baseline1yReturn20bd: ReadonlyArray<number>;
  /** Business days since the last shares-outstanding update for this ETF.
   *  Per F-CADENCE: bd_since_share_update > 3 = stale. */
  bdSinceShareUpdate: number;
}

/** Inputs to the composite evaluator. */
export interface EtfFlowInputs {
  asOf: Date;
  /** Wall-clock UTC of the most-recent yfinance ingest; null when ingest has
   *  never run. */
  lastYfinanceQueryAt: Date | null;
  perEtf: ReadonlyArray<EtfFlowPerEtfInput>;
  /** Optional (Gap #9 v2): secondary-source (ticker, date) panel for cross-
   *  validation. When non-empty AND a `primaryPanel` is also provided, the
   *  evaluator runs `compareEtfFlowPanels` and stamps the summary onto
   *  `snapshot.crossValidation`. When omitted OR empty, `crossValidation` is
   *  null and v1 back-compat is preserved. */
  secondaryPanel?: ReadonlyArray<EtfFlowSecondaryPoint>;
  /** Optional primary-source (ticker, date) panel — same shape as the
   *  secondary panel, BUT representing the yfinance reads that drove the
   *  per-ETF window. Required IFF `secondaryPanel` is provided; the
   *  comparator needs symmetric inputs. The repository (A4) assembles both
   *  from `quantlab.etf_shares_outstanding` filtered by `source`. */
  primaryPanel?: ReadonlyArray<EtfFlowPrimaryPoint>;
  /** Optional operator-facing label for the secondary source (e.g.
   *  `'issuer-csv'`, `'etfcom-scrape'`). Default `'issuer-csv'` when
   *  `secondaryPanel` is provided without an explicit label. */
  secondarySourceLabel?: string;
}

/** Output snapshot — mirrors SPEC §5.3 + CH column shape (see A3 migration). */
export interface EtfFlowSnapshot {
  snapshotDate: Date;
  lastYfinanceQueryAt: Date | null;
  /** Max bdSinceShareUpdate across the universe (F-CADENCE staleness scalar).
   *  Null when the universe is empty. */
  bdSinceLastShareUpdate: number | null;

  // Aggregate (F-5 / F-6 / F-7)
  sectorFlowDispersion: number | null;
  aggregateRiskOnFlow: number | null;
  aggregateFlowStressFlag: boolean;

  /** ETFs with divergence_flag=true OR |flow_z| > 2.0; deduplicated by ticker. */
  flaggedEtfs: ReadonlyArray<EtfFlowFlaggedEtf>;

  // Per-ETF (full v1 universe)
  perEtfRows: ReadonlyArray<EtfFlowPerEtfRow>;

  // Diagnostic counts (per SPEC §5.3 inputs_available block)
  inputsAvailableAggregateSector: number;
  inputsAvailableAggregateBroad: number;
  inputsAvailablePerEtf: number;
  version: EtfFlowCompositeVersion;

  /** Gap #9 v2 (optional): cross-validation summary against a secondary
   *  source. Absent (or null) when no `secondaryPanel` was provided OR when
   *  the intersection size was zero. Repository round-trip persists this via
   *  the existing `aggregate_json` blob (zero CH migration; mirrors S95-38
   *  posture). Pre-v2 snapshots deserialize without the field; the renderer
   *  + composer dispatch on `crossValidation != null && compared > 0`. */
  crossValidation?: EtfFlowCrossValidationSummary | null;
}

// ── Composite orchestrator ─────────────────────────────────────────────────

/** Evaluate the ETF-flow composite end-to-end.
 *
 *  Steps:
 *    1. Per-ETF: from each row's 21-day shares/close panel, compute
 *       flow_shares_20bd, flow_dollar_20bd, flow_pct_aum_t, return_20bd,
 *       flow_z (against 1y baseline), return_z_20bd, divergence_flag.
 *    2. Aggregate: from the per-ETF flow_z values, derive sector_flow_
 *       dispersion (11 SPDR sectors) and aggregate_risk_on_flow (6 broad-
 *       index). Derive aggregate_flow_stress_flag from the disjunction.
 *    3. Build the flagged_etfs list (divergence OR |z| > 2.0; deduplicated
 *       by ticker since a single ETF could satisfy both conditions).
 *
 *  No I/O. No side effects. Re-runnable with identical inputs.
 */
export function evaluateEtfFlowComposite(inputs: EtfFlowInputs): EtfFlowSnapshot {
  // Per-ETF layer
  const perEtfRows: EtfFlowPerEtfRow[] = [];
  let inputsAvailablePerEtf = 0;
  let maxStaleness: number | null = null;

  // Per-ticker map so the aggregate layer can pluck z-scores by group without
  // re-iterating the input list.
  const flowZByTicker = new Map<string, number | null>();

  for (const row of inputs.perEtf) {
    const group = resolveEtfGroup(row.ticker);
    const sharesT = row.shares21[row.shares21.length - 1];
    const closeT = row.closes21[row.closes21.length - 1];
    const sharesTMinus20bd = row.shares21[0];
    const closeTMinus20bd = row.closes21[0];

    const flowShares20bd = computeFlowShares20bd(sharesT, sharesTMinus20bd);
    const flowDollar20bd = computeFlowDollar20bd(row.shares21, row.closes21);
    const flowPctAumT = computeFlowPctAum(flowDollar20bd, sharesT, closeT);
    const return20bd = computeReturn20bd(closeT, closeTMinus20bd);

    const { z: flowZ } = computeZ(flowPctAumT, row.baseline1yFlowPctAum);
    const { z: returnZ20bd } = computeZ(return20bd, row.baseline1yReturn20bd);

    const divergenceFlag = flagDivergence(flowZ, returnZ20bd);

    const aumT = sharesT * closeT;

    if (flowPctAumT != null) inputsAvailablePerEtf++;
    if (maxStaleness == null || row.bdSinceShareUpdate > maxStaleness) {
      maxStaleness = row.bdSinceShareUpdate;
    }
    flowZByTicker.set(row.ticker, flowZ);

    perEtfRows.push({
      ticker: row.ticker,
      group,
      sharesOutstandingT: sharesT,
      closeT,
      aumT,
      flowShares20bd,
      flowDollar20bd,
      flowPctAumT,
      flowZ,
      return20bd,
      returnZ20bd,
      divergenceFlag,
      bdSinceShareUpdate: row.bdSinceShareUpdate,
    });
  }

  // Aggregate layer (F-5 / F-6 / F-7 / F-9)
  const sectorZs: (number | null)[] = SPDR_SECTOR_ETFS.map(
    (t) => (flowZByTicker.has(t) ? (flowZByTicker.get(t) ?? null) : null),
  );
  const broadZs: (number | null)[] = BROAD_INDEX_ETFS.map(
    (t) => (flowZByTicker.has(t) ? (flowZByTicker.get(t) ?? null) : null),
  );

  const sectorFlowDispersion = computeSectorFlowDispersion(sectorZs);
  const aggregateRiskOnFlow = computeAggregateRiskOnFlow(broadZs);
  const aggregateFlowStressFlag = flagAggregateFlowStress(
    sectorFlowDispersion,
    aggregateRiskOnFlow,
  );

  const inputsAvailableAggregateSector = sectorZs.filter((z) => z != null).length;
  const inputsAvailableAggregateBroad = broadZs.filter((z) => z != null).length;

  // flagged_etfs: divergence_flag=true OR |flow_z|>2.0; dedupe by ticker.
  const flaggedEtfs: EtfFlowFlaggedEtf[] = [];
  const flaggedSeen = new Set<string>();
  for (const row of perEtfRows) {
    const passesAbsZ =
      row.flowZ != null && Math.abs(row.flowZ) > FLAGGED_ETFS_ABS_Z_THRESHOLD;
    if (!row.divergenceFlag && !passesAbsZ) continue;
    if (flaggedSeen.has(row.ticker)) continue;
    if (row.flowZ == null || row.flowPctAumT == null) continue;
    flaggedSeen.add(row.ticker);
    flaggedEtfs.push({
      ticker: row.ticker,
      flowZ: row.flowZ,
      returnZ20bd: row.returnZ20bd,
      flowPctAumT: row.flowPctAumT,
      divergenceFlag: row.divergenceFlag,
    });
  }

  // Gap #9 v2 cross-validation. Runs IFF both panels are provided AND the
  // secondary panel has at least one row. Empty secondary OR missing primary
  // ⇒ crossValidation = null (back-compat with v1 fixtures). The summary's
  // `totalCompared` will report 0 when the intersection is empty even though
  // both panels are non-empty — operator reads that as "no overlap to check."
  let crossValidation: EtfFlowCrossValidationSummary | null = null;
  if (
    inputs.secondaryPanel != null &&
    inputs.secondaryPanel.length > 0 &&
    inputs.primaryPanel != null
  ) {
    const { divergences, totalCompared } = compareEtfFlowPanels(
      inputs.primaryPanel,
      inputs.secondaryPanel,
    );
    if (totalCompared > 0) {
      crossValidation = summarizeDivergences(
        divergences,
        totalCompared,
        inputs.secondarySourceLabel ?? DEFAULT_SECONDARY_SOURCE_LABEL,
      );
    }
  }

  return {
    snapshotDate: inputs.asOf,
    lastYfinanceQueryAt: inputs.lastYfinanceQueryAt,
    bdSinceLastShareUpdate: maxStaleness,

    sectorFlowDispersion,
    aggregateRiskOnFlow,
    aggregateFlowStressFlag,

    flaggedEtfs,

    perEtfRows,

    inputsAvailableAggregateSector,
    inputsAvailableAggregateBroad,
    inputsAvailablePerEtf,
    version: ETF_FLOW_COMPOSITE_VERSION,

    crossValidation,
  };
}

/**
 * What could break this:
 *   - 21-element panel-length invariant: computeFlowDollar20bd throws on
 *     wrong length. The repository (A4) is responsible for assembling exactly
 *     21 elements after carry-forward; a backfill arc that fetches a partial
 *     panel will fail loudly here (correct semantic — silent mis-attribution
 *     would be worse than a crash).
 *   - Sample vs population stddev: computeZ uses sample (n-1, baseline-as-
 *     sample); computeSectorFlowDispersion uses population (N, cross-section-
 *     as-population). The split is semantic-correct but easy to flip in a
 *     refactor; the test fixtures pin both formulas.
 *   - Divergence sign comparison: uses Math.sign which returns 0 for zero;
 *     the |z|>1 guard short-circuits before we ever compare signs of zero
 *     values (Math.abs(0) is not > 1). Safe for now; any future relaxation
 *     of the |z|>1 threshold to >0 must re-examine the zero-sign edge.
 *   - Cold-start aggregate cascade: a single sector ETF missing from
 *     flowZByTicker (e.g. the A4 read returned 10 sector ETFs not 11) drops
 *     sectorFlowDispersion to null per F-9. Operator sees this via
 *     inputsAvailableAggregateSector < 11 in the snapshot; A5 brief renders
 *     a cold-start fallback.
 *   - flowZByTicker dedup: if the input list contains the same ticker twice
 *     (mis-assembled by repository), the second row's flow_z overwrites the
 *     first in flowZByTicker AND a second perEtfRows entry is appended.
 *     Aggregate sees the latest z; per-ETF list has duplicates. The flagged-
 *     ETFs list deduplicates by ticker as a defensive belt-and-suspenders.
 *     A4 repository is expected to deliver one row per ticker; a soft-validate
 *     check could be added but would fight the pure-function discipline.
 *   - crossValidation field is OPTIONAL on the snapshot (v2 / Gap #9 v2). When
 *     `inputs.secondaryPanel` is provided, the evaluator runs
 *     `compareEtfFlowPanels` + `summarizeDivergences` and stamps the summary
 *     onto `snapshot.crossValidation`. When absent or empty, the field is
 *     null and back-compat with pre-v2 fixtures is preserved. The renderer
 *     dispatches on `crossValidation != null && compared > 0`.
 */
