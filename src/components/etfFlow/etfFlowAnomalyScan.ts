/**
 * Pure, client-side, unit-testable anomaly scan for the ETF-flow
 * cross-validation panel — Cycle 33 slice 3b (S96-147).
 *
 * EtfFlowApp predates the Cycle 33 bug-finding-first overlay. Unlike the
 * composite-detail panels, its payload (`EtfFlowCrossValidationStateResponse`)
 * is a cross-validation comparator — modes {empty, cross-validation,
 * secondary-only}, a divergence summary with a severity ladder — NOT a z-score
 * composite with metrics[]/history[]. So `scanCompositeAnomalies` is structurally
 * wrong here; this is a thin EtfFlow-specific scan that emits the SAME `Anomaly`
 * shape so the panel renders the SAME screaming top-of-page banner the other 8
 * panels use (the `ui-design-principles` bug-finding-first requirement: a source
 * disagreement must SCREAM on render, not hide in a tile count + table row).
 *
 * The load-bearing signal is a cross-source disagreement: the v1 yfinance
 * primary and the v3.1 SSGA secondary measure the SAME ETF's shares outstanding
 * on the SAME date — they should match within creation/redemption noise. A
 * material gap means one source is wrong (a units / split-adjustment / stale-feed
 * bug), and silently rendering it as a plausible "flow" is exactly the failure
 * mode the bug-finding-first overlay exists to catch.
 *
 * Pure: no React, no fetch, no clock. Lives in the client tree so the panel
 * imports it directly, but has zero UI dependencies so scripts/tests can
 * exercise every branch without a DOM.
 */
import type {
  EtfFlowCrossValidationStateResponse,
} from '../../server/etf_flow_dashboard.js';
import type { Anomaly, AnomalySeverity } from '../composite/anomalyScan.js';

/** |Δshares| at-or-above this between two independent sources on the same date
 *  is implausibly large for a real creation/redemption flow — it points at a
 *  units / split / stale-feed bug, not a genuine disagreement. The EtfFlow
 *  analog of the composite scan's OUT_OF_BAND_CRIT (the 937T% / z=27 catcher).
 *  Fractional (0.5 = 50%). Above the severity ladder's `critical` floor (5%);
 *  this is the "certainly a pipeline bug" tier. */
export const IMPLAUSIBLE_SHARES_PCT = 0.5;

const SEVERITY_RANK: Record<AnomalySeverity, number> = { critical: 0, warn: 1, info: 2 };

/**
 * Scan an ETF-flow cross-validation response for anomalies, worst-first.
 * Returns [] for the awaiting-data empty state (`mode === 'empty'`) — the
 * panel's rich EmptyState explains that case; an empty panel is not an anomaly.
 */
export function scanEtfFlowAnomalies(
  r: EtfFlowCrossValidationStateResponse,
): Anomaly[] {
  const out: Anomaly[] = [];

  // Empty mode — not an anomaly; the EmptyState component explains it.
  if (r.mode === 'empty') return out;

  // Secondary-only — the v1 yfinance primary is dark, so cross-validation is
  // BLIND (the comparison needs both sides). The data shown is single-source.
  if (r.mode === 'secondary-only') {
    out.push({
      code: 'PRIMARY_DARK',
      severity: 'warn',
      message:
        `v1 yfinance primary returned 0 rows in the ${r.lookbackDays}d window — ` +
        `cross-validation is blind (it needs both sources). The data shown is ` +
        `v3.1 secondary-only (S96-89 Yahoo SHO regression; resolution tracked ` +
        `under operator queue Q-6).`,
    });
    return out; // no divergence scan possible with one side empty
  }

  // Cross-validation mode — scan the divergence summary. (summary is always
  // populated in this mode per the builder; guard defensively.)
  const s = r.summary;
  if (!s) return out;

  // Implausible divergence — a units / split / source bug, not a real flow.
  if (Number.isFinite(s.maxAbsSharesPctDiff) && s.maxAbsSharesPctDiff >= IMPLAUSIBLE_SHARES_PCT) {
    out.push({
      code: 'IMPLAUSIBLE_DIVERGENCE',
      severity: 'critical',
      message:
        `Max |Δshares| is ${pct(s.maxAbsSharesPctDiff)} between the yfinance primary ` +
        `and SSGA secondary — implausibly large for two sources measuring the same ` +
        `ETF. Suspect a units / split-adjustment / stale-feed bug, not a real flow.`,
    });
  }

  // Critical-tier divergences (≥5%): the two sources materially disagree.
  if (s.bySeverity.critical > 0) {
    out.push({
      code: 'CRITICAL_DIVERGENCE',
      severity: 'critical',
      message:
        `${s.bySeverity.critical} ticker-day${s.bySeverity.critical === 1 ? '' : 's'} ` +
        `diverge ≥5% between the yfinance primary and SSGA secondary — the two ` +
        `shares-outstanding sources materially disagree${worstSuffix(r)}.`,
    });
  }

  // Warn-tier divergences (2–5%).
  if (s.bySeverity.warn > 0) {
    out.push({
      code: 'DIVERGENCE',
      severity: 'warn',
      message:
        `${s.bySeverity.warn} ticker-day${s.bySeverity.warn === 1 ? '' : 's'} ` +
        `diverge 2–5% between the two sources — worth confirming which feed is right.`,
    });
  }

  out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return out;
}

/** "; worst: SPY +12.3% on 2026-05-20" from the top divergence, or '' when the
 *  topDivergences list is empty (e.g. critical count > 0 but list truncated). */
function worstSuffix(r: EtfFlowCrossValidationStateResponse): string {
  const top = r.summary?.topDivergences?.[0];
  if (!top) return '';
  const sign = top.sharesPctDiff >= 0 ? '+' : '';
  return `; worst: ${top.ticker} ${sign}${pct(Math.abs(top.sharesPctDiff))} on ${top.date}`;
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * What could break this:
 *   - The scan trusts the server-computed `summary.bySeverity` + the severity
 *     ladder in etf_flow_cross_validation.ts (info <2% · warn 2–5% · critical
 *     ≥5%). If that classifier changes, the warn/critical messages here drift
 *     unless kept in sync — the thresholds are quoted in prose, not re-derived.
 *   - IMPLAUSIBLE_SHARES_PCT (50%) is a heuristic for "certainly a pipeline
 *     bug". A genuine but enormous same-date redemption could in principle trip
 *     it; it is `critical` (not auto-quarantine) for exactly that reason — it
 *     asks the operator to look, it doesn't block. ETF SHO between two sources
 *     on the same date realistically never moves 50% from a real flow.
 *   - `secondary-only` emits one PRIMARY_DARK warn that overlaps the panel's
 *     existing PrimaryDarkBanner prose — intentional: the banner is the
 *     standardized one-line top-of-page SCREAM, the prose banner is the detail.
 *   - info-tier divergences (<2%) are deliberately NOT surfaced — they are
 *     expected source noise, below the worth-screaming bar (mirrors how the
 *     composite scan ignores in-band z-scores).
 */
