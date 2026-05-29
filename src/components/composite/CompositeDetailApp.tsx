/**
 * CompositeDetailApp — the ONE reusable composite-detail panel (Cycle 33 /
 * S96-147). Parameterized by a CompositeDescriptor; renders any
 * CompositeDetailPayload returned from `/api/<composite>`.
 *
 * Five sections (per the `ui-design-principles` memory):
 *   1. Anomaly banner   — scanCompositeAnomalies output; bugs SCREAM here first.
 *   2. State hero       — plain-language verdict ABOVE the numbers + staleness.
 *   3. Coverage strip   — N/M lit input segments (fired-on-thin-data is visible).
 *   4. Metric bars      — position-on-scale bars with ±σ band; out-of-band
 *                         physically punches past the band and turns red.
 *   5. History          — per-metric sparklines + a verdict firing-lane.
 *   + Detail table with per-number data lineage (source table · as-of · value)
 *     and a glossary footer (plain-language meaning + flag meanings).
 *
 * Design language matches RegimeApp / CyclePositionApp / EtfFlowApp: dark,
 * monospace, hand-rolled inline SVG (NOT recharts), `null` → '—' (never 0).
 * Accent + tone colors are inline hex (a reusable component can't use dynamic
 * Tailwind class names — they'd be purged from the build).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CompositeDetailPayload, CompositeTone } from '../../server/composite_detail.js';
import {
  scanCompositeAnomalies,
  type Anomaly,
  type AnomalySeverity,
} from './anomalyScan.js';
import {
  toAnomalyScanConfig,
  type CompositeDescriptor,
  type CompositeMetricDescriptor,
} from './descriptors.js';

// ── Color maps (inline; dynamic Tailwind classes get purged) ─────────────────

const ACCENT_HEX: Record<string, string> = {
  cyan: '#22d3ee', amber: '#fbbf24', violet: '#a78bfa', emerald: '#34d399',
  fuchsia: '#e879f9', sky: '#38bdf8', rose: '#fb7185', lime: '#a3e635',
};
function accentHex(stem: string): string { return ACCENT_HEX[stem] ?? '#22d3ee'; }

const TONE_HEX: Record<CompositeTone, string> = {
  critical: '#f87171', // red-400
  warn: '#fbbf24',     // amber-400
  elevated: '#fb923c', // orange-400
  calm: '#38bdf8',     // sky-400
  neutral: '#a1a1aa',  // zinc-400
  unknown: '#71717a',  // zinc-500
};

const SEVERITY_HEX: Record<AnomalySeverity, string> = {
  critical: '#f87171', warn: '#fbbf24', info: '#a1a1aa',
};

const LOOKBACK_OPTIONS = [90, 365, 730, 1825];
const DEFAULT_LOOKBACK = 365;

interface State {
  data: CompositeDetailPayload | null;
  loading: boolean;
  error: string | null;
  lookbackDays: number;
}

export default function CompositeDetailApp({ descriptor }: { descriptor: CompositeDescriptor }) {
  const [state, setState] = useState<State>({
    data: null, loading: true, error: null, lookbackDays: DEFAULT_LOOKBACK,
  });
  const accent = accentHex(descriptor.accent);

  const refresh = useCallback(async (lookbackDays: number) => {
    setState(s => ({ ...s, loading: true, error: null, lookbackDays }));
    try {
      const r = await fetch(`${descriptor.endpoint}?lookbackDays=${lookbackDays}`);
      if (!r.ok) {
        let detail = `HTTP ${r.status}`;
        try {
          const body = await r.json();
          if (body && typeof body === 'object' && 'detail' in body) detail = `${body.error}: ${body.detail}`;
        } catch { /* keep HTTP status */ }
        throw new Error(detail);
      }
      const data = await r.json() as CompositeDetailPayload;
      setState({ data, loading: false, error: null, lookbackDays });
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, [descriptor.endpoint]);

  useEffect(() => { refresh(DEFAULT_LOOKBACK); }, [refresh]);

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <header className="h-16 border-b border-[#1a1a1a] flex items-center justify-between px-8 bg-black sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: accent, boxShadow: `0 0 10px ${accent}88` }} />
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-white italic">{descriptor.title}</h2>
          {state.data?.hasData && (
            <span className="text-[10px] font-mono text-zinc-500 ml-2">
              {state.data.compositeVersion ?? '—'} · {state.data.history.length} days loaded
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 text-[10px] font-mono">
            <span className="text-zinc-500 uppercase tracking-[0.15em]">window</span>
            {LOOKBACK_OPTIONS.map(opt => (
              <button
                key={opt}
                onClick={() => refresh(opt)}
                disabled={state.loading}
                className="px-2 py-0.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={state.lookbackDays === opt
                  ? { borderColor: `${accent}99`, color: accent, backgroundColor: `${accent}1a` }
                  : { borderColor: '#27272a', color: '#71717a' }}
              >
                {opt}d
              </button>
            ))}
          </div>
          <a href="/" className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500 hover:text-white transition-colors">← back</a>
          <button
            onClick={() => refresh(state.lookbackDays)}
            disabled={state.loading}
            className="text-[10px] font-mono uppercase tracking-[0.2em] border rounded px-3 py-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: accent, borderColor: `${accent}4d` }}
          >
            {state.loading ? 'loading…' : 'refresh'}
          </button>
        </div>
      </header>

      <main className="p-6 max-w-[1600px] mx-auto">
        {state.error && (
          <div className="border border-red-500/40 bg-red-500/10 rounded p-4 mb-4">
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-red-300 mb-1">Failed to load {descriptor.composite}</div>
            <div className="text-[11px] font-mono text-red-200/80">{state.error}</div>
          </div>
        )}
        {state.loading && !state.data && (
          <div className="text-[11px] font-mono text-zinc-500">loading {descriptor.composite}…</div>
        )}
        {state.data && !state.data.hasData && <EmptyState descriptor={descriptor} />}
        {state.data && state.data.hasData && (
          <DashboardLayout payload={state.data} descriptor={descriptor} accent={accent} />
        )}
      </main>
    </div>
  );
}

// ── Layout ───────────────────────────────────────────────────────────────────

function DashboardLayout({ payload, descriptor, accent }: {
  payload: CompositeDetailPayload; descriptor: CompositeDescriptor; accent: string;
}) {
  const anomalies = useMemo(
    () => scanCompositeAnomalies(payload, toAnomalyScanConfig(descriptor)),
    [payload, descriptor],
  );
  return (
    <div className="flex flex-col gap-4">
      <SubtitleBanner descriptor={descriptor} accent={accent} />
      <AnomalyBanner anomalies={anomalies} />
      <StateHero payload={payload} descriptor={descriptor} />
      <CoverageStrip payload={payload} descriptor={descriptor} accent={accent} />
      <MetricBars payload={payload} descriptor={descriptor} accent={accent} />
      <HistoryPanel payload={payload} descriptor={descriptor} accent={accent} />
      <MetricTable payload={payload} descriptor={descriptor} />
      <GlossaryFooter descriptor={descriptor} />
    </div>
  );
}

function SubtitleBanner({ descriptor, accent }: { descriptor: CompositeDescriptor; accent: string }) {
  return (
    <div className="border rounded p-3 flex items-start gap-3" style={{ borderColor: `${accent}4d`, backgroundColor: `${accent}0d` }}>
      <div className="text-[10px] font-black uppercase tracking-[0.2em] whitespace-nowrap pt-0.5" style={{ color: accent }}>Informational · v1</div>
      <div className="text-[11px] font-mono leading-relaxed" style={{ color: `${accent}cc` }}>{descriptor.subtitle}</div>
    </div>
  );
}

// ── 1. Anomaly banner — bugs scream here ─────────────────────────────────────

function AnomalyBanner({ anomalies }: { anomalies: Anomaly[] }) {
  if (anomalies.length === 0) {
    return (
      <div className="border border-emerald-500/25 bg-emerald-500/[0.04] rounded px-3 py-2 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <span className="text-[10px] font-mono text-emerald-300/80 uppercase tracking-[0.15em]">anomaly scan clean — no out-of-band, stale, or degenerate-baseline flags</span>
      </div>
    );
  }
  return (
    <div className="border border-zinc-700/60 bg-black/40 rounded p-3 flex flex-col gap-1.5">
      <div className="text-[9px] font-black uppercase tracking-[0.25em] text-zinc-400 mb-0.5">
        Anomaly scan — {anomalies.length} flag{anomalies.length === 1 ? '' : 's'}
      </div>
      {anomalies.map((a, i) => (
        <div key={`${a.code}-${a.metricKey ?? ''}-${i}`} className="flex items-start gap-2">
          <span className="text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded whitespace-nowrap mt-px"
            style={{ color: SEVERITY_HEX[a.severity], border: `1px solid ${SEVERITY_HEX[a.severity]}55`, backgroundColor: `${SEVERITY_HEX[a.severity]}14` }}>
            {a.severity}
          </span>
          <span className="text-[11px] font-mono leading-snug" style={{ color: `${SEVERITY_HEX[a.severity]}dd` }}>
            <span className="text-zinc-500">[{a.code}]</span> {a.message}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── 2. State hero — plain language above the numbers ─────────────────────────

function StateHero({ payload, descriptor }: { payload: CompositeDetailPayload; descriptor: CompositeDescriptor }) {
  const verdict = payload.verdict ?? 'unknown';
  const meaning = descriptor.verdicts[verdict];
  const tone = meaning?.tone ?? descriptor.defaultTone;
  const toneHex = TONE_HEX[tone];
  const stale = payload.staleDays;
  return (
    <div className="border border-[#1a1a1a] bg-[#0a0a0a] rounded p-5">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="flex flex-col gap-1.5">
          <div className="text-[9px] font-black uppercase tracking-[0.25em] text-zinc-500">current verdict</div>
          <div className="text-2xl font-black uppercase tracking-tight" style={{ color: toneHex }}>
            {verdict.replace(/_/g, ' ')}
          </div>
          <div className="text-[12px] font-mono text-zinc-300/90 max-w-[640px] leading-relaxed">
            {meaning?.meaning ?? 'No plain-language meaning registered for this verdict.'}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 text-[10px] font-mono text-zinc-500">
          <div>as of <span className="text-zinc-300">{payload.snapshotDate ?? '—'}</span></div>
          <div>
            freshness{' '}
            <span style={{ color: stale === null ? '#71717a' : stale >= 7 ? TONE_HEX.warn : stale >= 3 ? TONE_HEX.elevated : '#34d399' }}>
              {stale === null ? '—' : stale === 0 ? 'today' : `${stale}d old`}
            </span>
          </div>
          <div className="text-zinc-600">{payload.sourceTable}</div>
        </div>
      </div>
      {payload.context && payload.context.length > 0 && (
        <div className="mt-3 pt-3 border-t border-[#141414] flex flex-wrap gap-x-6 gap-y-1.5">
          {payload.context.map(c => (
            <div key={c.label} className="text-[10px] font-mono">
              <span className="text-zinc-500 uppercase tracking-wider">{c.label}: </span>
              <span className="text-zinc-200">{c.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 3. Coverage strip ────────────────────────────────────────────────────────

function CoverageStrip({ payload, descriptor, accent }: {
  payload: CompositeDetailPayload; descriptor: CompositeDescriptor; accent: string;
}) {
  const lit = payload.inputsPresentCount;
  const total = payload.inputsTotal;
  const degraded = lit < total;
  return (
    <div className="border border-[#1a1a1a] bg-[#0a0a0a] rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[9px] font-black uppercase tracking-[0.25em] text-zinc-500">input coverage</div>
        <div className="text-[10px] font-mono" style={{ color: degraded ? TONE_HEX.warn : '#34d399' }}>
          {lit}/{total} present{degraded ? ' · partial' : ''}
        </div>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {descriptor.inputBits.map(b => {
          const on = (payload.inputsPresent & b.bit) !== 0;
          return (
            <div key={b.label}
              className="flex items-center gap-1.5 px-2 py-1 rounded border text-[9px] font-mono uppercase tracking-wider"
              style={on
                ? { borderColor: `${accent}66`, color: accent, backgroundColor: `${accent}12` }
                : { borderColor: '#27272a', color: '#52525b', backgroundColor: 'transparent' }}
              title={on ? `${b.label}: present this snapshot` : `${b.label}: MISSING this snapshot`}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: on ? accent : '#3f3f46' }} />
              {b.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 4. Metric bars — position-on-scale with ±σ band ──────────────────────────

function MetricBars({ payload, descriptor, accent }: {
  payload: CompositeDetailPayload; descriptor: CompositeDescriptor; accent: string;
}) {
  const valueByKey = new Map(payload.metrics.map(m => [m.key, m.value]));
  const zMetrics = descriptor.metrics.filter(m => m.unit === 'z');
  const rawMetrics = descriptor.metrics.filter(m => m.unit === 'raw');
  return (
    <div className="border border-[#1a1a1a] bg-[#0a0a0a] rounded p-4">
      <div className="text-[9px] font-black uppercase tracking-[0.25em] text-zinc-500 mb-3">
        standardized indicators (z-scores · position on ±σ scale)
      </div>
      <div className="flex flex-col gap-3">
        {zMetrics.map(m => (
          // key lives on an intrinsic wrapper (codebase convention — TS does not
          // inject `key` into locally-defined component prop types here).
          <div key={m.key}>
            <ZBar metric={m} value={valueByKey.get(m.key) ?? null} accent={accent} />
          </div>
        ))}
      </div>
      {rawMetrics.length > 0 && (
        <div className="mt-4 pt-3 border-t border-[#1a1a1a] flex flex-wrap gap-6">
          {rawMetrics.map(m => (
            <div key={m.key} className="flex flex-col gap-0.5">
              <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500" title={m.glossary}>{m.label}</div>
              <div className="text-sm font-mono text-zinc-200">{fmt(valueByKey.get(m.key) ?? null)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ZBar({ metric, value, accent }: { metric: CompositeMetricDescriptor; value: number | null; accent: string }) {
  const crit = metric.critAbs ?? 4;
  const warn = metric.warnAbs ?? 2;
  const domain = Math.max(6, crit * 1.5); // scale extent each side of 0
  const v = value;
  const clamped = v === null ? null : Math.max(-domain, Math.min(domain, v));
  const outOfBandCrit = v !== null && Math.abs(v) > crit;
  const outOfBandWarn = v !== null && Math.abs(v) > warn;
  const barHex = outOfBandCrit ? TONE_HEX.critical : outOfBandWarn ? TONE_HEX.warn : accent;
  const toPct = (x: number) => ((x + domain) / (2 * domain)) * 100; // 0..100 across track
  return (
    <div className="flex items-center gap-3">
      <div className="w-16 text-[10px] font-mono uppercase tracking-wider text-zinc-400 text-right shrink-0" title={metric.glossary}>{metric.short}</div>
      <div className="relative flex-1 h-6 rounded bg-black border border-[#1a1a1a] overflow-hidden">
        {/* warn band shading */}
        <div className="absolute top-0 bottom-0" style={{ left: `${toPct(-warn)}%`, width: `${toPct(warn) - toPct(-warn)}%`, backgroundColor: '#ffffff08' }} />
        {/* center line (z=0) */}
        <div className="absolute top-0 bottom-0 w-px" style={{ left: '50%', backgroundColor: '#3f3f46' }} />
        {/* warn + crit threshold ticks */}
        {[-crit, -warn, warn, crit].map((t, i) => (
          <div key={i} className="absolute top-0 bottom-0 w-px" style={{ left: `${toPct(t)}%`, backgroundColor: Math.abs(t) === crit ? '#f8717155' : '#fbbf2455' }} />
        ))}
        {/* the value bar: from center to value */}
        {clamped !== null && (
          <div className="absolute top-1 bottom-1 rounded-sm"
            style={{
              left: `${Math.min(50, toPct(clamped))}%`,
              width: `${Math.abs(toPct(clamped) - 50)}%`,
              backgroundColor: barHex,
              boxShadow: outOfBandCrit ? `0 0 8px ${barHex}` : 'none',
            }} />
        )}
        {/* out-of-band arrow marker at the edge */}
        {v !== null && Math.abs(v) > domain && (
          <div className="absolute top-0 bottom-0 flex items-center text-[10px] font-black"
            style={v > 0 ? { right: 2, color: TONE_HEX.critical } : { left: 2, color: TONE_HEX.critical }}>
            {v > 0 ? '▸' : '◂'}
          </div>
        )}
      </div>
      <div className="w-14 text-right text-[11px] font-mono shrink-0" style={{ color: barHex }} title={`z = ${value ?? '—'}`}>
        {value === null || !Number.isFinite(value) ? '—' : (value >= 0 ? '+' : '') + value.toFixed(2)}
      </div>
    </div>
  );
}

// ── 5. History — sparklines + verdict firing lane ────────────────────────────

function HistoryPanel({ payload, descriptor, accent }: {
  payload: CompositeDetailPayload; descriptor: CompositeDescriptor; accent: string;
}) {
  const zMetrics = descriptor.metrics.filter(m => m.unit === 'z');
  if (payload.history.length < 2) {
    return (
      <div className="border border-[#1a1a1a] bg-[#0a0a0a] rounded p-4 text-[10px] font-mono text-zinc-600">
        history — only {payload.history.length} snapshot(s) in window; trend needs ≥2.
      </div>
    );
  }
  return (
    <div className="border border-[#1a1a1a] bg-[#0a0a0a] rounded p-4">
      <div className="text-[9px] font-black uppercase tracking-[0.25em] text-zinc-500 mb-3">
        trend ({payload.history.length}d) — each z-metric self-scaled; firing lane = verdict per day
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {zMetrics.map(m => (
          <div key={m.key}>
            <Sparkline label={m.short} series={payload.history.map(h => h.metrics[m.key] ?? null)} accent={accent} crit={m.critAbs ?? 4} />
          </div>
        ))}
      </div>
      <FiringLane payload={payload} descriptor={descriptor} />
    </div>
  );
}

function Sparkline({ label, series, accent, crit }: { label: string; series: (number | null)[]; accent: string; crit: number }) {
  const W = 220, H = 44, pad = 3;
  const pts = series.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null && Number.isFinite(p.v));
  if (pts.length < 2) return <div className="text-[9px] font-mono text-zinc-600">{label}: no series</div>;
  const vals = pts.map(p => p.v);
  const lo = Math.min(...vals, -crit), hi = Math.max(...vals, crit);
  const span = hi - lo || 1;
  const n = series.length - 1;
  const x = (i: number) => pad + (i / n) * (W - 2 * pad);
  const y = (v: number) => pad + (1 - (v - lo) / span) * (H - 2 * pad);
  const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const outCrit = Math.abs(last.v) > crit;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">{label}</span>
        <span className="text-[10px] font-mono" style={{ color: outCrit ? TONE_HEX.critical : accent }}>{(last.v >= 0 ? '+' : '') + last.v.toFixed(2)}</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="bg-black rounded border border-[#1a1a1a]">
        {/* zero line */}
        {lo < 0 && hi > 0 && <line x1={pad} x2={W - pad} y1={y(0)} y2={y(0)} stroke="#27272a" strokeWidth="1" />}
        {/* ±crit band edges */}
        <line x1={pad} x2={W - pad} y1={y(crit)} y2={y(crit)} stroke="#f8717133" strokeWidth="1" strokeDasharray="2 2" />
        <line x1={pad} x2={W - pad} y1={y(-crit)} y2={y(-crit)} stroke="#f8717133" strokeWidth="1" strokeDasharray="2 2" />
        <path d={d} fill="none" stroke={outCrit ? TONE_HEX.critical : accent} strokeWidth="1.5" />
        <circle cx={x(last.i)} cy={y(last.v)} r="2" fill={outCrit ? TONE_HEX.critical : accent} />
      </svg>
    </div>
  );
}

function FiringLane({ payload, descriptor }: { payload: CompositeDetailPayload; descriptor: CompositeDescriptor }) {
  const days = payload.history;
  // collapse to a reasonable strip width — show up to last 180 days as ticks.
  const shown = days.length > 180 ? days.slice(days.length - 180) : days;
  return (
    <div className="mt-4 pt-3 border-t border-[#1a1a1a]">
      <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500 mb-1.5">verdict firing lane ({shown.length}d shown)</div>
      <div className="flex gap-px h-5 items-stretch">
        {shown.map((h, i) => {
          const tone = h.verdict ? (descriptor.verdicts[h.verdict]?.tone ?? descriptor.defaultTone) : 'unknown';
          return (
            <div key={`${h.date}-${i}`} className="flex-1 min-w-px rounded-sm"
              style={{ backgroundColor: TONE_HEX[tone] }}
              title={`${h.date}: ${h.verdict ?? '—'}`} />
          );
        })}
      </div>
    </div>
  );
}

// ── Detail table with data lineage ───────────────────────────────────────────

function MetricTable({ payload, descriptor }: { payload: CompositeDetailPayload; descriptor: CompositeDescriptor }) {
  const valueByKey = new Map(payload.metrics.map(m => [m.key, m.value]));
  const flagByKey = new Map(payload.flags.map(f => [f.key, f.value]));
  return (
    <div className="border border-[#1a1a1a] bg-[#0a0a0a] rounded p-4">
      <div className="text-[9px] font-black uppercase tracking-[0.25em] text-zinc-500 mb-3">indicators — value · band · lineage</div>
      <table className="w-full text-[11px] font-mono">
        <thead>
          <tr className="text-zinc-600 text-left">
            <th className="font-normal pb-1.5">indicator</th>
            <th className="font-normal pb-1.5 text-right">value</th>
            <th className="font-normal pb-1.5 text-right">band</th>
            <th className="font-normal pb-1.5 text-right">lineage</th>
          </tr>
        </thead>
        <tbody>
          {descriptor.metrics.map(m => {
            const v = valueByKey.get(m.key) ?? null;
            const band = m.unit === 'z' && v !== null
              ? (Math.abs(v) > (m.critAbs ?? Infinity) ? 'crit' : Math.abs(v) > (m.warnAbs ?? Infinity) ? 'warn' : 'in-band')
              : '—';
            const bandHex = band === 'crit' ? TONE_HEX.critical : band === 'warn' ? TONE_HEX.warn : '#52525b';
            return (
              <tr key={m.key} className="border-t border-[#141414]">
                <td className="py-1.5 text-zinc-300" title={m.glossary}>{m.label}</td>
                <td className="py-1.5 text-right text-zinc-200">{fmt(v)}{m.unit === 'z' ? 'σ' : ''}</td>
                <td className="py-1.5 text-right" style={{ color: bandHex }}>{band}</td>
                <td className="py-1.5 text-right text-zinc-600"
                  title={`source: ${payload.sourceTable}\nas-of: ${payload.snapshotDate ?? '—'}\nvalue: ${v ?? 'null'}\ninputs present: ${payload.inputsPresentCount}/${payload.inputsTotal}`}>
                  {payload.sourceTable.split('.').pop()} · {payload.snapshotDate ?? '—'}
                </td>
              </tr>
            );
          })}
          {descriptor.flags.map(f => {
            const on = flagByKey.get(f.key) ?? false;
            return (
              <tr key={f.key} className="border-t border-[#141414]">
                <td className="py-1.5 text-zinc-300" title={f.whenTrue}>{f.label}</td>
                <td className="py-1.5 text-right" style={{ color: on ? '#34d399' : '#52525b' }}>{on ? 'TRUE' : 'false'}</td>
                <td className="py-1.5 text-right text-zinc-600">flag</td>
                <td className="py-1.5 text-right text-zinc-600" title={f.whenTrue}>{payload.sourceTable.split('.').pop()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Glossary footer ──────────────────────────────────────────────────────────

function GlossaryFooter({ descriptor }: { descriptor: CompositeDescriptor }) {
  return (
    <div className="border border-[#1a1a1a] bg-[#070707] rounded p-4">
      <div className="text-[9px] font-black uppercase tracking-[0.25em] text-zinc-500 mb-2">what each number means</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2">
        {descriptor.metrics.map(m => (
          <div key={m.key} className="text-[10px] font-mono leading-relaxed">
            <span className="text-zinc-300">{m.label}</span>
            {m.teachDoc && <a href={m.teachDoc} className="text-cyan-400/70 hover:text-cyan-300 ml-1.5">[teach ↗]</a>}
            <span className="text-zinc-500"> — {m.glossary}</span>
          </div>
        ))}
        {descriptor.flags.map(f => (
          <div key={f.key} className="text-[10px] font-mono leading-relaxed">
            <span className="text-zinc-300">{f.label}</span>
            <span className="text-zinc-500"> — true when: {f.whenTrue}</span>
          </div>
        ))}
      </div>
      <div className="text-[9px] font-mono text-zinc-600 mt-3 pt-2 border-t border-[#141414]">
        SPEC: <span className="text-zinc-500">{descriptor.specPath}</span>
      </div>
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ descriptor }: { descriptor: CompositeDescriptor }) {
  return (
    <div className="border border-amber-500/30 bg-amber-500/5 rounded p-6">
      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-300 mb-2">Awaiting first daemon cycle</div>
      <div className="text-[11px] font-mono text-amber-100/80 leading-relaxed">
        No snapshot rows for <code className="text-amber-200">{descriptor.composite}</code> yet (table empty or absent). To populate:
      </div>
      <pre className="mt-3 text-[10px] font-mono text-amber-200 bg-black/40 border border-amber-500/20 rounded p-3 leading-snug whitespace-pre-wrap">
{descriptor.ingestHint.join('\n')}
      </pre>
      <div className="text-[10px] font-mono text-zinc-500 mt-3">SPEC: <span className="text-zinc-400">{descriptor.specPath}</span></div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function fmt(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return (v >= 0 ? '' : '') + v.toFixed(2);
}
