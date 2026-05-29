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

// ── sector_rotation ──────────────────────────────────────────────────────────
// Input bits mirror src/server/sector_rotation.ts INPUT_* (1<<0 … 1<<5).

export const sectorRotationDescriptor: CompositeDescriptor = {
  composite: 'sector_rotation',
  endpoint: '/api/sector-rotation',
  title: 'VECTOR_SECTOR · Sector Rotation',
  accent: 'amber',
  subtitle:
    'Equity-internal rotation the broad-market classifier is blind to: defensive-vs-cyclical leadership, top-sector volume concentration, growth/value spread, SPY proximity to its 52w high. Informational only in v1.',
  specPath: 'docs/specs/sector-rotation.md',
  ingestHint: [
    '# 1. Ensure schema exists (idempotent):',
    'npm run migrate:create-sector-rotation-snapshots',
    'npm run migrate:create-sector-rotation-snapshots:apply',
    '',
    '# 2. Run the daemon once to write the first snapshot:',
    'npm run daemon:daily',
  ],
  metrics: [
    {
      key: 'defensiveCyclicalSpreadZ',
      label: 'Defensive−Cyclical spread z',
      short: 'Def−Cyc',
      unit: 'z', warnAbs: 2, critAbs: 4,
      glossary:
        'How far the (defensive − cyclical) 20-day return spread sits from its trailing-1y average, in σ. Strongly positive = defensives leading (late-cycle / risk-off tilt).',
    },
    {
      key: 'topSectorVolumeShareZ',
      label: 'Top-sector volume concentration z',
      short: 'Conc',
      unit: 'z', warnAbs: 2, critAbs: 4,
      glossary:
        'Standardized share of total sector-ETF $-volume captured by the single busiest sector. High z = unusually concentrated flow into one sector.',
    },
    {
      key: 'defensiveCyclicalSpread',
      label: 'Defensive−Cyclical 20d spread',
      short: 'Spread',
      unit: 'raw',
      glossary: 'Raw (defensive − cyclical) mean 20-day return, decimal (0.02 = +2%). The z-score above standardizes this.',
    },
    {
      key: 'topSectorVolumeShare',
      label: 'Top-sector volume share',
      short: 'Share',
      unit: 'raw',
      glossary: 'Busiest sector’s 20d $-volume ÷ total across all 11 SPDR sectors (0..1). ~0.09 = even; higher = concentrated.',
    },
    {
      key: 'spyPctOff52wHigh',
      label: 'SPY % off 52w high',
      short: 'SPY',
      unit: 'raw',
      glossary: '(SPY close − 52w high) / 52w high. 0 = at the high; negative = below. The defensive-lead flag only fires near the high.',
    },
    {
      key: 'growthValueSpread',
      label: 'Growth−Value 20d spread',
      short: 'G−V',
      unit: 'raw',
      glossary: 'IWF (growth) − IWD (value) 20-day return. Informational; not gated. Positive = growth leading.',
    },
  ],
  flags: [
    {
      key: 'defensiveLeadActive',
      label: 'Defensive leadership',
      whenTrue: 'Defensive−cyclical spread z > +1 AND SPY within 5% of its 52w high — classic late-cycle defensives-leading-from-the-top pattern.',
    },
    {
      key: 'concentrationExtremeActive',
      label: 'Concentration extreme',
      whenTrue: 'Top-sector volume-share z > +1.5 — flow unusually concentrated in one sector.',
    },
  ],
  verdicts: {
    severe_rotation: { tone: 'critical', meaning: 'Both defensive-leadership AND concentration-extreme active — a strong risk-off rotation signal.' },
    concentration_extreme: { tone: 'warn', meaning: 'Volume unusually concentrated in one sector (no defensive-leadership signal).' },
    defensive_leadership: { tone: 'elevated', meaning: 'Defensives leading near the market high — late-cycle tilt.' },
    normal: { tone: 'neutral', meaning: 'No defensive-leadership or concentration signal — sector internals in their usual state.' },
    unknown: { tone: 'unknown', meaning: 'A required input (returns / volumes / SPY context / z-baselines) was missing — could not classify.' },
  },
  defaultTone: 'neutral',
  inputBits: [
    { bit: 1 << 0, label: 'DEF-RET' },
    { bit: 1 << 1, label: 'CYC-RET' },
    { bit: 1 << 2, label: 'VOLUMES' },
    { bit: 1 << 3, label: 'SPY-CTX' },
    { bit: 1 << 4, label: 'GROW/VAL' },
    { bit: 1 << 5, label: 'Z-BASE' },
  ],
};

// ── cross_asset ──────────────────────────────────────────────────────────────
// Input bits mirror src/server/cross_asset_signals.ts INPUT_* (1<<0 … 1<<5).

export const crossAssetDescriptor: CompositeDescriptor = {
  composite: 'cross_asset',
  endpoint: '/api/cross-asset',
  title: 'VECTOR_XASSET · Cross-Asset Stress',
  accent: 'rose',
  subtitle:
    'Non-equity stress the classifier misses: broad-dollar strength, 10y real-rate spikes, copper/gold growth signal, credit internals, and multi-segment curve inversion. Informational only in v1.',
  specPath: 'docs/specs/cross-asset-signals.md',
  ingestHint: [
    '# 1. Ensure schema exists (idempotent):',
    'npm run migrate:create-cross-asset-snapshots',
    'npm run migrate:create-cross-asset-snapshots:apply',
    '',
    '# 2. Run the daemon once to write the first snapshot:',
    'npm run daemon:daily',
  ],
  metrics: [
    {
      key: 'creditInternalsDiffZ',
      label: 'Credit internals (HY-OAS − BAA) z',
      short: 'Credit',
      unit: 'z', warnAbs: 2, critAbs: 4,
      glossary:
        'Standardized spread between high-yield OAS and BAA credit spread. High z = high-yield stress diverging from investment-grade — an internal credit-deterioration signal.',
    },
    {
      key: 'dxy20dChangePct',
      label: 'Broad dollar 20d change',
      short: 'DXY',
      unit: 'raw',
      glossary: 'DTWEXBGS broad-dollar index 20-day change (decimal). Fires the dollar-shock flag above +3% — a strong dollar tightens global financial conditions.',
    },
    {
      key: 'realRate10y20dChangeBps',
      label: '10y real rate 20d change (bps)',
      short: 'RealRt',
      unit: 'raw',
      glossary: '10-year TIPS yield (DFII10) 20-day change in basis points. Fires the real-rate-spike flag above +50bps — rising real rates compress equity multiples.',
    },
    {
      key: 'copperGoldRatio20dChangePct',
      label: 'Copper/Gold ratio 20d change',
      short: 'Cu/Au',
      unit: 'raw',
      glossary: 'COPX/GLD ratio 20-day change (decimal). Fires the growth-collapse flag below −5% — copper falling vs gold signals growth weakness.',
    },
    {
      key: 'invertedSegmentCount',
      label: 'Inverted curve segments',
      short: 'Curve',
      unit: 'raw',
      glossary: 'How many of {T10Y2Y, T10Y3M} are inverted (≤0), 0..2. Fires the curve-distortion flag at 2.',
    },
  ],
  flags: [
    { key: 'dxyStrengthActive', label: 'Dollar strength', whenTrue: 'Broad dollar 20d change > +3% — a dollar shock.' },
    { key: 'realRateSpikeActive', label: 'Real-rate spike', whenTrue: '10y real rate rose > +50bps over 20 days.' },
    { key: 'commodityGrowthCollapseActive', label: 'Commodity growth collapse', whenTrue: 'Copper/gold ratio fell > 5% over 20 days — growth weakness.' },
    { key: 'creditInternalsDivergenceActive', label: 'Credit internals divergence', whenTrue: 'HY-OAS minus BAA spread z > +1.5 — high-yield stress.' },
    { key: 'curveDistortionActive', label: 'Curve distortion', whenTrue: 'Both T10Y2Y AND T10Y3M inverted.' },
  ],
  verdicts: {
    severe_cross_asset_stress: { tone: 'critical', meaning: '2+ cross-asset stress flags active simultaneously — broad non-equity stress.' },
    dollar_shock: { tone: 'warn', meaning: 'Broad dollar surging — global-conditions tightening (sole active flag).' },
    real_rate_spike: { tone: 'warn', meaning: '10y real rates spiking — multiple-compression pressure (sole active flag).' },
    commodity_growth_collapse: { tone: 'warn', meaning: 'Copper/gold signalling growth weakness (sole active flag).' },
    credit_internals_divergence: { tone: 'warn', meaning: 'High-yield stress diverging from investment-grade (sole active flag).' },
    curve_distortion: { tone: 'warn', meaning: 'Yield curve inverted across both tracked segments (sole active flag).' },
    normal: { tone: 'neutral', meaning: 'No cross-asset stress flags active.' },
    unknown: { tone: 'unknown', meaning: 'A required input category (DXY / real rates / curve / commodities / credit-z) was missing — could not classify.' },
  },
  defaultTone: 'neutral',
  inputBits: [
    { bit: 1 << 0, label: 'DXY' },
    { bit: 1 << 1, label: 'REAL-RT' },
    { bit: 1 << 2, label: 'CURVE' },
    { bit: 1 << 3, label: 'COMMOD' },
    { bit: 1 << 4, label: 'CREDIT-Z' },
    { bit: 1 << 5, label: 'FX-CTX' },
  ],
};
