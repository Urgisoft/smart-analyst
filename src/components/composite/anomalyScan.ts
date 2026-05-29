/**
 * Pure, client-side, unit-testable anomaly scan for composite-detail panels.
 *
 * Cycle 33 (S96-147). This is the load-bearing bug-finding requirement from the
 * `ui-design-principles` memory: anomalies must SCREAM on render rather than
 * wait for the operator to notice in a screenshot. The function takes a
 * CompositeDetailPayload + a per-composite AnomalyScanConfig (derived from the
 * descriptor) and returns the anomalies a human should see, sorted
 * worst-first. It is the check that would have caught:
 *   - the 937T% return bug (NON_FINITE / OUT_OF_BAND), and
 *   - the OQ-C31-1 z=27 zero-inflated-baseline artifact (OUT_OF_BAND_CRIT +
 *     DEGENERATE_BASELINE).
 *
 * Pure: no React, no fetch, no clock except an injectable `now`. Lives in the
 * client tree so the panel imports it directly, but has zero UI dependencies so
 * scripts/tests can exercise every branch without a DOM.
 */
import type { CompositeDetailPayload } from '../../server/composite_detail.js';

export type AnomalySeverity = 'critical' | 'warn' | 'info';

export interface Anomaly {
  /** Stable machine code, e.g. 'OUT_OF_BAND_CRIT'. */
  code: string;
  severity: AnomalySeverity;
  /** Human-readable, plain-language message (for the non-statistician). */
  message: string;
  /** The metric this anomaly is about, when applicable. */
  metricKey?: string;
}

/** Per-metric band config the scan needs. Derived from a metric descriptor. */
export interface MetricScanConfig {
  key: string;
  label: string;
  /** 'z' metrics get ±σ band checks; 'raw' metrics are skipped for band/
   *  degenerate checks (a raw VIX-point value has no universal plausible band). */
  unit: 'z' | 'raw';
  /** |value| beyond this → warn. Only used for unit:'z'. */
  warnAbs?: number;
  /** |value| beyond this → critical. Only used for unit:'z'. */
  critAbs?: number;
}

export interface AnomalyScanConfig {
  metrics: MetricScanConfig[];
  /** staleDays ≥ this → info. Default 3. */
  staleInfoDays?: number;
  /** staleDays ≥ this → warn. Default 7. */
  staleWarnDays?: number;
  /** Min distinct-value ratio over history before a z metric is flagged as a
   *  degenerate / zero-inflated baseline. Default 0.15 (i.e. <15% distinct
   *  across ≥ minHistoryForDegenerate points = suspicious). */
  degenerateDistinctRatio?: number;
  /** Minimum non-null history points required before the degenerate-baseline
   *  check runs. Default 12. */
  minHistoryForDegenerate?: number;
}

const SEVERITY_RANK: Record<AnomalySeverity, number> = { critical: 0, warn: 1, info: 2 };

/**
 * Scan a composite-detail payload for anomalies. Returns [] for the
 * awaiting-first-cycle empty state (hasData=false) — an empty panel is not an
 * anomaly. Results are sorted critical → warn → info, stable within a tier.
 */
export function scanCompositeAnomalies(
  payload: CompositeDetailPayload,
  config: AnomalyScanConfig,
  opts: { now?: Date } = {},
): Anomaly[] {
  void opts; // `now` reserved; staleDays is precomputed server-side.
  const out: Anomaly[] = [];
  if (!payload.hasData) return out;

  const staleInfoDays = config.staleInfoDays ?? 3;
  const staleWarnDays = config.staleWarnDays ?? 7;
  const distinctRatio = config.degenerateDistinctRatio ?? 0.15;
  const minHistory = config.minHistoryForDegenerate ?? 12;

  const byKey = new Map(config.metrics.map(m => [m.key, m]));
  const latestByKey = new Map(payload.metrics.map(m => [m.key, m.value]));

  // ── 1. Non-finite values (a non-null value that isn't finite = pipeline bug)
  for (const m of payload.metrics) {
    if (m.value !== null && !Number.isFinite(m.value)) {
      out.push({
        code: 'NON_FINITE',
        severity: 'critical',
        metricKey: m.key,
        message: `${label(byKey, m.key)} is ${String(m.value)} — not a finite number. Upstream calculation produced NaN/Infinity.`,
      });
    }
  }

  // ── 2. Out-of-band z-scores (the OQ-C31-1 z=27 catcher) ─────────────────────
  for (const m of payload.metrics) {
    const cfg = byKey.get(m.key);
    if (!cfg || cfg.unit !== 'z' || m.value === null || !Number.isFinite(m.value)) continue;
    const abs = Math.abs(m.value);
    if (cfg.critAbs !== undefined && abs > cfg.critAbs) {
      out.push({
        code: 'OUT_OF_BAND_CRIT',
        severity: 'critical',
        metricKey: m.key,
        message: `${cfg.label} z = ${m.value.toFixed(2)} is past ±${cfg.critAbs}σ — implausibly extreme. Suspect a baseline / coverage artifact, not a real reading.`,
      });
    } else if (cfg.warnAbs !== undefined && abs > cfg.warnAbs) {
      out.push({
        code: 'OUT_OF_BAND',
        severity: 'warn',
        metricKey: m.key,
        message: `${cfg.label} z = ${m.value.toFixed(2)} is past ±${cfg.warnAbs}σ — unusually extreme; worth confirming the inputs.`,
      });
    }
  }

  // ── 3. Coverage ─────────────────────────────────────────────────────────────
  if (payload.inputsPresentCount === 0) {
    out.push({
      code: 'NO_COVERAGE',
      severity: 'critical',
      message: `0 of ${payload.inputsTotal} inputs were present — this snapshot fired on no data.`,
    });
  } else if (payload.inputsPresentCount < payload.inputsTotal) {
    out.push({
      code: 'COVERAGE_DEGRADED',
      severity: 'warn',
      message: `Only ${payload.inputsPresentCount} of ${payload.inputsTotal} inputs were present — the reading rests on partial data.`,
    });
  }

  // ── 4. Staleness ────────────────────────────────────────────────────────────
  if (payload.staleDays !== null) {
    if (payload.staleDays >= staleWarnDays) {
      out.push({
        code: 'STALE',
        severity: 'warn',
        message: `Latest snapshot is ${payload.staleDays}d old (${payload.snapshotDate ?? '—'}). The daemon cadence was missed — this is not today's reading.`,
      });
    } else if (payload.staleDays >= staleInfoDays) {
      out.push({
        code: 'STALE',
        severity: 'info',
        message: `Latest snapshot is ${payload.staleDays}d old (${payload.snapshotDate ?? '—'}).`,
      });
    }
  }

  // ── 5. Unknown verdict (load-bearing input missing) ─────────────────────────
  if (payload.verdict === 'unknown') {
    out.push({
      code: 'UNKNOWN_VERDICT',
      severity: 'info',
      message: `Verdict is 'unknown' — a load-bearing input was missing, so the composite could not classify.`,
    });
  }

  // ── 6. Degenerate / zero-inflated baseline + day-over-day discontinuity ─────
  for (const cfg of config.metrics) {
    if (cfg.unit !== 'z') continue;
    const series = payload.history
      .map(h => h.metrics[cfg.key])
      .filter((v): v is number => v !== null && Number.isFinite(v));

    if (series.length >= minHistory) {
      const distinct = new Set(series.map(v => Math.round(v * 100) / 100)).size;
      if (distinct / series.length < distinctRatio) {
        out.push({
          code: 'DEGENERATE_BASELINE',
          severity: 'warn',
          metricKey: cfg.key,
          message: `${cfg.label} takes only ${distinct} distinct value(s) across ${series.length} days — a zero-inflated / pinned baseline. z-scores off this baseline are unreliable (the OQ-C31-1 failure mode).`,
        });
      }
    }

    // Day-over-day discontinuity: last two non-null points jump past the crit band.
    if (cfg.critAbs !== undefined && series.length >= 2) {
      const a = series[series.length - 2];
      const b = series[series.length - 1];
      const jump = Math.abs(b - a);
      if (jump > cfg.critAbs) {
        out.push({
          code: 'DISCONTINUITY',
          severity: 'warn',
          metricKey: cfg.key,
          message: `${cfg.label} jumped ${jump.toFixed(2)} day-over-day (${a.toFixed(2)} → ${b.toFixed(2)}) — larger than the ±${cfg.critAbs}σ band. Confirm the inputs didn't break.`,
        });
      }
    }
  }

  void latestByKey; // reserved for future cross-metric checks.
  out.sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]);
  return out;
}

function label(byKey: Map<string, MetricScanConfig>, key: string): string {
  return byKey.get(key)?.label ?? key;
}

/**
 * What could break this:
 *   - JSON cannot carry NaN/Infinity (JSON.stringify → null), so NON_FINITE
 *     fires only if a non-null non-finite value somehow reaches the client
 *     (e.g. a hand-built payload in a test). In production, non-finite values
 *     arrive as null and are correctly treated as "not computable", not as a
 *     bug. The OUT_OF_BAND check is the real production artifact-catcher.
 *   - DEGENERATE_BASELINE rounds to 2dp before counting distinct values; a
 *     metric that legitimately sits in a tight 2dp range for a long calm
 *     stretch could trip it. It's a warn (not critical) for exactly that
 *     reason — it asks the operator to look, it doesn't quarantine.
 *   - The scan trusts server-computed staleDays + inputsPresentCount; if the
 *     projection miscomputes those, the scan inherits the error. Those are
 *     covered by the dashboard projection tests.
 */
