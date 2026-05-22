/**
 * ETF-flow cross-validation — Gap #9 v2 framework (Phase A2-extension).
 *
 * SPEC: docs/specs/etf-flow-monitoring.md §11 OQ3 ("Yahoo Finance shares-
 *       outstanding accuracy vs creation/redemption truth ... operator can
 *       cross-validate against issuer pages"). v2 lands the comparison
 *       machinery; live secondary ingest (issuer CSV / ETF.com scrape) is
 *       a follow-up slice (v3).
 *
 * Purpose:
 *   Compare two (ticker, date) shares-outstanding panels — typically
 *   (primary = yfinance, secondary = issuer-supplied CSV) — and emit a
 *   divergence row per (ticker, date) where the two sources disagree by
 *   more than a threshold on either shares OR AUM.
 *
 *   This module is pure-function + I/O-free. The repository (A4) is
 *   responsible for assembling both panels; the brief (A5) renders the
 *   summary; the composite evaluator (A2) wires the orchestration via the
 *   optional `secondaryPanel` input on `EtfFlowInputs`.
 *
 * Canon:
 *   The cross-validation discipline is canon-grounded in CLAUDE.md's
 *   data-source policy: every secondary scrape MUST have schema validation
 *   + parse-failure alerts + cache-last-good + no silent stale-data
 *   propagation. The COMPARISON layer (this module) is the framework that
 *   downstream consumers use to convert raw "two panels" into operator-
 *   visible "divergence row" anomalies.
 *
 *   The 50bp / 100bp / 200bp / 500bp severity ladder is calibrated to
 *   yfinance's typical T+1/T+2 lag against issuer-reported shares: a >5%
 *   gap is almost certainly a real data-quality problem (split adjustment
 *   mismatch, ticker remap, stale corp-action handling), not a settlement-
 *   timing artifact.
 *
 * Design choices (locked at SPEC time):
 *   - Severity ladder symmetric in absolute %: info < 2%, warn < 5%,
 *     critical ≥ 5%. Below the entry threshold (default 0.5%) no
 *     divergence row is emitted. The thresholds are NOT in-sample-tuned;
 *     they are operator-readable round numbers matching the typical noise-
 *     vs-signal split for ETF shares-outstanding data.
 *   - Intersection-only comparison: a (ticker, date) pair must appear in
 *     BOTH panels to be eligible for divergence. Asymmetric coverage
 *     (primary has dates secondary doesn't, or vice versa) is NOT itself
 *     a divergence — that's a data-coverage question handled separately
 *     via `totalCompared` in the summary.
 *   - Severity = max(severity-of-shares-pct-diff, severity-of-aum-pct-
 *     diff). Both fields are considered; the worse wins. AUM-only
 *     divergences (shares match but close differs) can fire here when the
 *     secondary source reports a different close.
 *   - Empty secondary panel ⇒ zero divergence rows, totalCompared = 0.
 *     Back-compat with v1 fixtures and pre-v2 evaluator calls.
 *
 * What this module does NOT do:
 *   - Does NOT fetch / scrape / parse any external source. v2 is framework-
 *     only; live secondary ingest lives in a follow-up slice's Python
 *     `scripts/etf_flow_issuer_csv_ingest.py` + matching `source`-filtered
 *     reader on `etf_flow_repository.ts`.
 *   - Does NOT mutate the v1 composite outputs (per_etf_rows, flagged_etfs,
 *     aggregate scalars). The composite's primary computation runs on the
 *     PRIMARY panel only; cross-validation is an orthogonal anomaly stream.
 *   - Does NOT persist anomalies to a separate CH table in v2. The summary
 *     piggy-backs on the existing `aggregate_json` blob (mirrors S95-38
 *     zero-migration posture for EK per-EVENT recency).
 */

// ── SPEC-pinned thresholds (re-tuning bumps composite version) ──────────────

/** Entry threshold: |sharesPctDiff| or |aumPctDiff| must exceed this for a
 *  divergence row to emit. 50bp matches typical T+1 settlement-timing noise
 *  on yfinance shares-outstanding vs issuer-reported shares. */
export const XV_DIVERGENCE_ENTRY_THRESHOLD = 0.005;

/** Severity ladder upper bound for `info`. */
export const XV_SEVERITY_INFO_UPPER = 0.02;

/** Severity ladder upper bound for `warn` (inclusive of info upper). */
export const XV_SEVERITY_WARN_UPPER = 0.05;

/** Top-N divergence rows surfaced in the summary's `topDivergences` array
 *  (operator brief renders this slice). Matches the §13 flagged-ETFs N=5
 *  convention. */
export const XV_TOP_DIVERGENCES_N = 5;

export type EtfFlowDivergenceSeverity = 'info' | 'warn' | 'critical';

/** One day of a secondary-source panel: (ticker, date, shares, close).
 *  Shape mirrors `quantlab.etf_shares_outstanding` for ingest symmetry —
 *  a follow-up slice's issuer-CSV ingest writes the same shape with
 *  `source != 'yfinance'`, and the repository reader filters by source. */
export interface EtfFlowSecondaryPoint {
  ticker: string;
  /** ISO date `YYYY-MM-DD` (matches the primary panel's CH date column). */
  date: string;
  shares: number;
  close: number;
}

/** Same shape for the primary panel, for symmetric input typing. */
export type EtfFlowPrimaryPoint = EtfFlowSecondaryPoint;

/** One divergence row: a (ticker, date) intersection where the two panels
 *  disagree by more than the entry threshold on shares OR AUM. */
export interface EtfFlowDivergence {
  ticker: string;
  date: string;
  primaryShares: number;
  secondaryShares: number;
  /** (primary - secondary) / max(|primary|, |secondary|, ε). Signed:
   *  positive when primary > secondary. */
  sharesPctDiff: number;
  primaryAum: number;
  secondaryAum: number;
  /** (primary - secondary) / max(|primary|, |secondary|, ε). Signed. */
  aumPctDiff: number;
  /** max(severity(|sharesPctDiff|), severity(|aumPctDiff|)). */
  severity: EtfFlowDivergenceSeverity;
}

export interface EtfFlowCrossValidationSummary {
  /** Number of (ticker, date) pairs present in BOTH panels (the universe
   *  over which divergence was evaluated). */
  totalCompared: number;
  /** Number of pairs that exceeded the entry threshold. */
  divergenceCount: number;
  /** Max |sharesPctDiff| across all emitted divergences; 0 when none. */
  maxAbsSharesPctDiff: number;
  /** Max |aumPctDiff| across all emitted divergences; 0 when none. */
  maxAbsAumPctDiff: number;
  /** Per-ticker count of compared pairs + divergence count + max |shares%|. */
  byTicker: Readonly<Record<string, {
    compared: number;
    diverged: number;
    maxAbsSharesPctDiff: number;
  }>>;
  /** Count per severity tier. */
  bySeverity: Readonly<Record<EtfFlowDivergenceSeverity, number>>;
  /** Top-N divergences by max(|sharesPctDiff|, |aumPctDiff|), descending. */
  topDivergences: ReadonlyArray<EtfFlowDivergence>;
  /** Human-readable label for the secondary source (operator-facing). */
  secondarySourceLabel: string;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Classify a non-negative |pctDiff| into a severity tier.
 *  Below the entry threshold returns `'info'` — the caller is responsible
 *  for filtering out sub-threshold values BEFORE emitting a divergence row. */
export function classifySeverity(
  absPctDiff: number,
): EtfFlowDivergenceSeverity {
  if (absPctDiff >= XV_SEVERITY_WARN_UPPER) return 'critical';
  if (absPctDiff >= XV_SEVERITY_INFO_UPPER) return 'warn';
  return 'info';
}

/** Symmetric signed percent diff: (a - b) / max(|a|, |b|, ε).
 *  Returns 0 when both inputs are 0 (degenerate; no divergence by definition).
 *  Symmetric in the denominator so |pctDiff(a, b)| === |pctDiff(b, a)|. */
function symmetricPctDiff(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  if (denom < 1e-12) return 0;
  return (a - b) / denom;
}

/** Build an intersection lookup: (ticker, date) -> primary point. */
function indexPanel(
  panel: ReadonlyArray<EtfFlowPrimaryPoint>,
): Map<string, EtfFlowPrimaryPoint> {
  const map = new Map<string, EtfFlowPrimaryPoint>();
  for (const p of panel) {
    map.set(`${p.ticker}|${p.date}`, p);
  }
  return map;
}

// ── Comparator ──────────────────────────────────────────────────────────────

export interface CompareOptions {
  /** Override the entry threshold (default: XV_DIVERGENCE_ENTRY_THRESHOLD). */
  entryThreshold?: number;
}

/** Compare two (ticker, date) panels and emit one divergence row per
 *  intersecting pair where |sharesPctDiff| OR |aumPctDiff| exceeds the
 *  entry threshold. Iteration order matches the primary panel's order so
 *  the output is deterministic for byte-equal-stdout test pinning.
 *
 *  Returns ALSO the `totalCompared` count (intersection size) so the
 *  caller can pass it into `summarizeDivergences` without re-intersecting. */
export function compareEtfFlowPanels(
  primary: ReadonlyArray<EtfFlowPrimaryPoint>,
  secondary: ReadonlyArray<EtfFlowSecondaryPoint>,
  opts: CompareOptions = {},
): { divergences: EtfFlowDivergence[]; totalCompared: number } {
  const entry = opts.entryThreshold ?? XV_DIVERGENCE_ENTRY_THRESHOLD;
  const secondaryIdx = indexPanel(secondary);
  const divergences: EtfFlowDivergence[] = [];
  let totalCompared = 0;
  for (const p of primary) {
    const s = secondaryIdx.get(`${p.ticker}|${p.date}`);
    if (s == null) continue;
    totalCompared++;
    const primaryAum = p.shares * p.close;
    const secondaryAum = s.shares * s.close;
    const sharesPctDiff = symmetricPctDiff(p.shares, s.shares);
    const aumPctDiff = symmetricPctDiff(primaryAum, secondaryAum);
    const absShares = Math.abs(sharesPctDiff);
    const absAum = Math.abs(aumPctDiff);
    if (absShares <= entry && absAum <= entry) continue;
    const severity: EtfFlowDivergenceSeverity = classifySeverity(
      Math.max(absShares, absAum),
    );
    divergences.push({
      ticker: p.ticker,
      date: p.date,
      primaryShares: p.shares,
      secondaryShares: s.shares,
      sharesPctDiff,
      primaryAum,
      secondaryAum,
      aumPctDiff,
      severity,
    });
  }
  return { divergences, totalCompared };
}

/** Aggregate a divergence list into the snapshot-payload summary.
 *  `totalCompared` is the intersection size from `compareEtfFlowPanels`. */
export function summarizeDivergences(
  divergences: ReadonlyArray<EtfFlowDivergence>,
  totalCompared: number,
  secondarySourceLabel: string,
): EtfFlowCrossValidationSummary {
  const byTickerMut: Record<string, {
    compared: number;
    diverged: number;
    maxAbsSharesPctDiff: number;
  }> = {};
  const bySeverityMut: Record<EtfFlowDivergenceSeverity, number> = {
    info: 0,
    warn: 0,
    critical: 0,
  };
  let maxAbsSharesPctDiff = 0;
  let maxAbsAumPctDiff = 0;
  for (const d of divergences) {
    const slot = byTickerMut[d.ticker] ?? {
      compared: 0,
      diverged: 0,
      maxAbsSharesPctDiff: 0,
    };
    slot.diverged += 1;
    const absShares = Math.abs(d.sharesPctDiff);
    if (absShares > slot.maxAbsSharesPctDiff) slot.maxAbsSharesPctDiff = absShares;
    byTickerMut[d.ticker] = slot;
    bySeverityMut[d.severity] += 1;
    if (absShares > maxAbsSharesPctDiff) maxAbsSharesPctDiff = absShares;
    const absAum = Math.abs(d.aumPctDiff);
    if (absAum > maxAbsAumPctDiff) maxAbsAumPctDiff = absAum;
  }
  // Fold `compared` counts into byTicker — the `compared` field needs the
  // FULL intersection per ticker, not just the divergent rows. We don't
  // have the intersection list at this layer; the caller's expected
  // contract is to pass `totalCompared` as the universe-wide count and
  // accept that `byTicker[t].compared` is initialized lazily (only tickers
  // that produced a divergence appear). Operator reads this as
  // "this ticker had N divergent days" not "this ticker had N-of-M days".
  // The per-ticker compared count is a v3 enhancement if operator asks.
  const topDivergences = [...divergences]
    .sort((a, b) => {
      const aMax = Math.max(Math.abs(a.sharesPctDiff), Math.abs(a.aumPctDiff));
      const bMax = Math.max(Math.abs(b.sharesPctDiff), Math.abs(b.aumPctDiff));
      return bMax - aMax;
    })
    .slice(0, XV_TOP_DIVERGENCES_N);
  return {
    totalCompared,
    divergenceCount: divergences.length,
    maxAbsSharesPctDiff,
    maxAbsAumPctDiff,
    byTicker: byTickerMut,
    bySeverity: bySeverityMut,
    topDivergences,
    secondarySourceLabel,
  };
}

/**
 * What could break this:
 *   - Symmetric pct-diff denominator: uses max(|a|, |b|, ε). When both
 *     panels report shares=0 (degenerate; should never occur for the v1
 *     21-ETF universe), pctDiff = 0 by short-circuit — NO divergence row
 *     emits. Operator must read this as "both sources agree on zero," not
 *     as "no data." The repository is responsible for not feeding zero-
 *     shares fixtures.
 *   - Intersection-only semantics: a ticker present in primary but absent
 *     from secondary contributes zero compared pairs and zero divergences.
 *     Asymmetric coverage is a data-coverage question handled separately.
 *     Operator must NOT read "zero divergences" as "secondary agrees" when
 *     `totalCompared == 0`.
 *   - Top-N sort tiebreak: two divergences at identical max-abs-pct-diff
 *     sort in their original (primary-panel) order because Array.sort is
 *     stable in modern Node. Test fixtures with deliberate tie-cases pin
 *     this; a future Node version that breaks sort stability would shuffle
 *     the tied rows but the count + max would remain correct.
 *   - bySeverity uses the SAME severity classification as the row-emit
 *     filter — `classifySeverity` is the single source of truth. A future
 *     refactor that introduces a separate "row should emit" predicate must
 *     keep the two in sync, or rows will leak into a tier that doesn't
 *     show in the summary count.
 *   - byTicker.compared is lazily populated only for tickers that produced
 *     a divergence row (see comment in summarizeDivergences). v3 wiring
 *     can pass through a per-ticker compared count if operator asks; v2
 *     reports `totalCompared` at the universe level only.
 */
