/**
 * Composite-detail wire contract — the NORMALIZED shape every Layer-0
 * composite-detail panel returns from its `/api/<composite>` route.
 *
 * Cycle 33 (S96-147) — the catch-up UI cycle. The 7 under-surfaced composites
 * (vol_structure, sector_rotation, cross_asset, short_interest,
 * executive_departure, eight_k, form_4) share a snapshot shape: a set of named
 * z-scores + boolean indicator flags + an `inputs_present` bitmask + a discrete
 * verdict/regime label + a daily history series. Rather than write 7 bespoke
 * dashboards, every composite's dashboard route projects its own snapshot into
 * THIS shape, and one reusable client component (CompositeDetailApp) renders
 * any payload given a per-composite CompositeDescriptor.
 *
 * Design source: memory `ui-design-principles` (s96 #26) + HANDOFF Cycle 33.
 *   - Bug-finding is the load-bearing requirement: the payload carries enough
 *     for a pure, client-side, unit-testable anomaly scan (NaN/Inf, out-of-band
 *     z, degenerate/zero-inflated baseline, staleness, coverage-degraded). That
 *     scan is the check that would have caught the OQ-C31-1 z=27 artifact at
 *     render time.
 *   - Data lineage on every number: `sourceTable` + `snapshotDate` +
 *     `evaluatedAt` + `inputsPresent` decode travel with the payload so the
 *     client can show where each number came from.
 *
 * This module is pure (no CH import) so the helpers are unit-testable in
 * isolation. The per-composite dashboard modules do the I/O.
 */

// ── Verdict tone (drives the state-hero + firing-lane colors client-side) ────

export type CompositeTone =
  | 'critical' // severe stress / strong signal
  | 'warn'     // moderate stress / elevated
  | 'elevated' // mild / watch
  | 'calm'     // benign / complacent
  | 'neutral'  // normal / no signal
  | 'unknown'; // could not evaluate (load-bearing input missing)

// ── Latest-snapshot projections ──────────────────────────────────────────────

export interface CompositeMetricValue {
  /** Descriptor field key, e.g. 'vixZ'. Matches a CompositeMetricDescriptor. */
  key: string;
  /** The z-score / numeric value. null = not computable this snapshot
   *  (renders as '—', never 0 — zero would lie about the reading). */
  value: number | null;
}

export interface CompositeFlagValue {
  key: string;
  value: boolean;
}

/** A categorical / non-numeric piece of context for the state hero, e.g.
 *  sector_rotation's most-concentrated sector symbol or cross_asset's active
 *  flag count. Kept as a string so non-numeric labels (a ticker, a count, a
 *  segment name) surface honestly alongside the numeric metrics. */
export interface CompositeContextItem {
  label: string;
  value: string;
}

// ── History (ASC by date) — trend + sign-flip / degenerate-baseline scan ─────

export interface CompositeHistoryPoint {
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** Discrete verdict/state label at this snapshot (firing lane). null when
   *  the composite did not emit a label that day. */
  verdict: string | null;
  /** Per-metric values keyed by descriptor field key. Missing/non-finite
   *  values are stored as null. */
  metrics: Record<string, number | null>;
}

// ── The full payload ─────────────────────────────────────────────────────────

export interface CompositeDetailPayload {
  /** Stable composite key, e.g. 'vol_structure'. */
  composite: string;
  /** Composite version stamped on the latest snapshot, e.g. 'vol_struct_v1'. */
  compositeVersion: string | null;
  /** Source CH table the numbers trace to (lineage). */
  sourceTable: string;
  /** False = table absent OR zero rows → client renders the
   *  awaiting-first-cycle empty state (NOT a 503). */
  hasData: boolean;
  /** Latest snapshot date YYYY-MM-DD, or null when hasData=false. */
  snapshotDate: string | null;
  /** ISO timestamp the latest snapshot was computed at, or null. */
  evaluatedAt: string | null;
  /** Whole days between the latest snapshot date and the server wall clock.
   *  Drives the staleness banner. null when hasData=false. */
  staleDays: number | null;
  /** Discrete verdict/regime label, e.g. 'severe_stress'. null when none. */
  verdict: string | null;
  /** Optional categorical context items (e.g. most-concentrated sector,
   *  active-flag count). Rendered in the state hero. Omitted when none. */
  context?: CompositeContextItem[];
  /** Latest per-metric values (descriptor order resolved client-side). */
  metrics: CompositeMetricValue[];
  /** Latest boolean indicator flags. */
  flags: CompositeFlagValue[];
  /** Bitmask of raw inputs present this snapshot. */
  inputsPresent: number;
  /** popcount(inputsPresent) — lit segments in the coverage strip. */
  inputsPresentCount: number;
  /** Total raw inputs the composite expects (coverage strip denominator). */
  inputsTotal: number;
  /** The lookback window the history was scoped to. */
  lookbackDays: number;
  /** Trailing history in ASC date order. Empty when hasData=false. */
  history: CompositeHistoryPoint[];
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Count set bits in a non-negative 32-bit integer. Used for the coverage
 *  strip denominator + the COVERAGE_DEGRADED anomaly check. */
export function popcount(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  let v = Math.floor(n);
  let c = 0;
  while (v > 0) {
    c += v & 1;
    v >>>= 1;
  }
  return c;
}

/**
 * Whole calendar days between a YYYY-MM-DD snapshot date and `now`. Clamped at
 * 0 (a future snapshot date — impossible in normal operation — reads as fresh,
 * not negative-stale). Returns null for an unparseable date so the caller can
 * decide how to surface it.
 */
export function computeStaleDays(snapshotDate: string, now: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(snapshotDate);
  if (!m) return null;
  const snap = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((today - snap) / 86_400_000);
  return days < 0 ? 0 : days;
}

/** The empty (awaiting-first-cycle) payload. Returned when the snapshots table
 *  is absent or has zero rows. Always 200 + hasData=false (graceful-degrade
 *  posture, mirrors cycle_position_dashboard.ts). */
export function emptyCompositeDetail(args: {
  composite: string;
  sourceTable: string;
  inputsTotal: number;
  lookbackDays: number;
}): CompositeDetailPayload {
  return {
    composite: args.composite,
    compositeVersion: null,
    sourceTable: args.sourceTable,
    hasData: false,
    snapshotDate: null,
    evaluatedAt: null,
    staleDays: null,
    verdict: null,
    metrics: [],
    flags: [],
    inputsPresent: 0,
    inputsPresentCount: 0,
    inputsTotal: args.inputsTotal,
    lookbackDays: args.lookbackDays,
    history: [],
  };
}

/**
 * What could break this:
 *   - `computeStaleDays` works in UTC date arithmetic. A snapshot written
 *     near midnight local time could read 1 day staler/fresher than a
 *     local-time calc would — acceptable for a freshness banner (the panel
 *     shows the actual snapshotDate too).
 *   - `popcount` assumes a 32-bit-ish mask; all current composites use ≤ 8
 *     input bits, well within range.
 *   - This module is intentionally CH-free; if a future composite needs
 *     server-computed lineage (μ/σ/N behind a z), that belongs in the
 *     per-composite dashboard projection, not here.
 */
