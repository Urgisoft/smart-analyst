/**
 * Composite descriptors — the per-composite configuration that parameterizes
 * the ONE reusable CompositeDetailApp (Cycle 33 / S96-147).
 *
 * A descriptor is pure data: labels, plain-language glossary, plausibility
 * bands, verdict meanings, coverage-bit labels, and the API endpoint. The
 * server's `/api/<composite>` route returns a normalized CompositeDetailPayload
 * (numbers + lineage); the descriptor supplies the human/meaning layer the
 * payload deliberately omits. Add a composite = add a descriptor here + a thin
 * <Composite>App wrapper + a server projection. No new rendering code.
 *
 * Design source: memory `ui-design-principles`.
 */
import type { CompositeTone } from '../../server/composite_detail.js';
import type { AnomalyScanConfig, MetricScanConfig } from './anomalyScan.js';

export interface CompositeMetricDescriptor {
  /** Matches a payload metric key, e.g. 'vixZ'. */
  key: string;
  /** Full label, e.g. 'VIX z-score'. */
  label: string;
  /** Short label for the bars panel axis, e.g. 'VIX'. */
  short: string;
  /** Plain-language hover glossary (for a non-statistician). */
  glossary: string;
  /** 'z' = standardized score (gets a ±σ band + bar); 'raw' = a raw unit value
   *  (no band — rendered as a plain number). */
  unit: 'z' | 'raw';
  /** ±band for z metrics: |z| beyond warnAbs = amber, beyond critAbs = red.
   *  Omitted for raw metrics. */
  warnAbs?: number;
  critAbs?: number;
  /** Optional deep-link to a docs/teach/ explainer. */
  teachDoc?: string;
}

export interface CompositeFlagDescriptor {
  key: string;
  label: string;
  /** Plain-language meaning when the flag is true. */
  whenTrue: string;
}

export interface VerdictMeaning {
  tone: CompositeTone;
  /** One-sentence plain-language meaning of this verdict. */
  meaning: string;
}

export interface CompositeDescriptor {
  /** Stable composite key (matches payload.composite). */
  composite: string;
  /** API endpoint, e.g. '/api/vol-structure'. */
  endpoint: string;
  /** Header title, e.g. 'VECTOR_VOL · Volatility Term-Structure'. */
  title: string;
  /** Tailwind color stem for the accent, e.g. 'cyan' (used as `${accent}-400`). */
  accent: string;
  /** Always-visible one-liner subtitle. */
  subtitle: string;
  /** Spec path (shown in the footer + empty state). */
  specPath: string;
  /** Commands shown in the awaiting-first-cycle empty state. */
  ingestHint: string[];
  metrics: CompositeMetricDescriptor[];
  flags: CompositeFlagDescriptor[];
  /** Verdict label → tone + meaning. */
  verdicts: Record<string, VerdictMeaning>;
  /** Tone for a verdict not in the map. */
  defaultTone: CompositeTone;
  /** Coverage-strip segments: each raw input bit + its label, in the same
   *  order/values as the server-side INPUT_* bitmask. */
  inputBits: { bit: number; label: string }[];
}

/** Build the AnomalyScanConfig the scan needs from a descriptor (the band /
 *  unit subset). Keeps the scan decoupled from the full descriptor. */
export function toAnomalyScanConfig(d: CompositeDescriptor): AnomalyScanConfig {
  const metrics: MetricScanConfig[] = d.metrics.map(m => ({
    key: m.key,
    label: m.label,
    unit: m.unit,
    warnAbs: m.warnAbs,
    critAbs: m.critAbs,
  }));
  return { metrics };
}

// ── vol_structure (reference descriptor) ─────────────────────────────────────
// Input bits mirror src/server/vol_structure.ts INPUT_* (1<<0 … 1<<4).

export const volStructureDescriptor: CompositeDescriptor = {
  composite: 'vol_structure',
  endpoint: '/api/vol-structure',
  title: 'VECTOR_VOL · Volatility Term-Structure',
  accent: 'cyan',
  subtitle:
    'Full VIX-family term structure (VIX9D · VIX · VIX3M · VIX6M) + VVIX — reads curve shape, not just a two-point inversion. Informational only in v1; does not fire phase1_v3.',
  specPath: 'docs/specs/expanded-vol-structure.md',
  ingestHint: [
    '# 1. Ensure schema exists (idempotent):',
    'npm run migrate:create-vol-structure-snapshots',
    'npm run migrate:create-vol-structure-snapshots:apply',
    '',
    '# 2. Run the daemon once to write the first snapshot:',
    'npm run daemon:daily',
  ],
  metrics: [
    {
      key: 'vixZ',
      label: 'VIX z-score',
      short: 'VIX',
      unit: 'z',
      warnAbs: 2,
      critAbs: 4,
      glossary:
        'How far today’s 30-day VIX sits from its trailing-2y average, in standard deviations. +2 = unusually high fear; −2 = unusual calm.',
    },
    {
      key: 'vvixZ',
      label: 'VVIX z-score',
      short: 'VVIX',
      unit: 'z',
      warnAbs: 2,
      critAbs: 4,
      glossary:
        'Vol-of-vol (how much the VIX itself is expected to move). Spikes ahead of event risk even when VIX is quiet — the divergence flag watches exactly that.',
    },
    {
      key: 'curveSteepnessZ',
      label: 'Curve steepness z-score',
      short: 'Steep',
      unit: 'z',
      warnAbs: 2,
      critAbs: 4,
      glossary:
        '(VIX6M − VIX9D) / VIX, standardized. Strongly negative = backwardation (near-term fear > long-term); strongly positive = steep contango (complacency).',
    },
    {
      key: 'inversionDepth',
      label: 'Inversion depth',
      short: 'Inv',
      unit: 'raw',
      glossary:
        'VIX9D − VIX6M in VIX points, only when the curve is monotonically backwardated (else 0). A raw magnitude, not a z-score — bigger = deeper near-term stress.',
    },
  ],
  flags: [
    {
      key: 'monotonicBackwardation',
      label: 'Monotonic backwardation',
      whenTrue: 'VIX9D > VIX > VIX3M > VIX6M — the whole curve is inverted, classic acute-stress shape.',
    },
    {
      key: 'vvixVixDivergence',
      label: 'VVIX/VIX divergence',
      whenTrue: 'VVIX elevated (z > +1) while VIX is below average — the market is pricing event risk the spot VIX hasn’t shown yet.',
    },
  ],
  verdicts: {
    severe_stress: { tone: 'critical', meaning: 'Whole curve backwardated AND steepness deeply negative — acute, broad volatility stress.' },
    moderate_stress: { tone: 'warn', meaning: 'Curve backwardated (near-term fear above long-term), without the severe-steepness threshold.' },
    event_risk: { tone: 'elevated', meaning: 'VVIX is pricing event risk the spot VIX hasn’t — a quiet-surface, nervous-underneath reading.' },
    complacent: { tone: 'calm', meaning: 'Steep contango — the market is pricing unusual calm. Complacency, not safety.' },
    normal: { tone: 'neutral', meaning: 'No stress or complacency signal — term structure in its usual shape.' },
    unknown: { tone: 'unknown', meaning: 'VIX itself was missing — the composite could not evaluate.' },
  },
  defaultTone: 'neutral',
  inputBits: [
    { bit: 1 << 0, label: 'VIX9D' },
    { bit: 1 << 1, label: 'VIX' },
    { bit: 1 << 2, label: 'VIX3M' },
    { bit: 1 << 3, label: 'VIX6M' },
    { bit: 1 << 4, label: 'VVIX' },
  ],
};
