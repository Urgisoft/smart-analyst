/**
 * 252-day regime timeline — Panel C.
 *
 * One column per trading day, colored by regime. Hover surfaces the day's
 * categories_firing breakdown. The thin lane above the heatmap shows
 * `categories_firing` (0..3 today, 0..4 under future phase2_v1) as a tiny
 * sparkline so persistence vs noise is visible without hovering.
 *
 * Decision supported: "are we in a regime cluster or a one-off label?"
 *
 * SPEC: docs/specs/regime-dashboard-component3.md §3.3 (Panel C).
 */
import { useMemo, useState } from 'react';
import type { TimelineEntry } from '../../../server/regime_dashboard.js';
import type { Regime } from '../../../server/macro_regime.js';

const REGIME_FILL: Record<Regime, string> = {
  green:  'fill-emerald-500/55',
  yellow: 'fill-yellow-500/65',
  orange: 'fill-orange-500/70',
  red:    'fill-red-500/75',
};

const REGIME_TEXT: Record<Regime, string> = {
  green:  'text-emerald-300',
  yellow: 'text-yellow-300',
  orange: 'text-orange-300',
  red:    'text-red-300',
};

export function TimelineHeatmap({ rows }: { rows: TimelineEntry[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const hoverEntry = hoverIdx != null ? rows[hoverIdx] : null;
  const span = useMemo(() => {
    if (rows.length === 0) return { start: '—', end: '—' };
    return { start: rows[0].date, end: rows[rows.length - 1].date };
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="border border-[#1a1a1a] bg-black rounded p-6 text-center text-[11px] font-mono text-zinc-500">
        No timeline data — `quantlab.macro_regimes` returned 0 rows.
      </div>
    );
  }

  // Sparkline above heatmap: max 4 (Phase 2). Bar height encodes count.
  const maxCats = 4;

  return (
    <div className="border border-[#1a1a1a] bg-black rounded">
      <div className="border-b border-[#1a1a1a] px-3 py-2 flex items-center justify-between">
        <div>
          <div className="text-xs font-black uppercase tracking-[0.2em] text-white">
            Regime timeline · {rows.length} trading days
          </div>
          <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
            {span.start} → {span.end} · hover for day detail · sparkline above = categories_firing
          </div>
        </div>
        {hoverEntry ? (
          <div className="flex items-center gap-3 text-[10px] font-mono">
            <span className="text-zinc-400">{hoverEntry.date}</span>
            <span className={REGIME_TEXT[hoverEntry.regime]}>{hoverEntry.regime}</span>
            <span className="text-zinc-500">cats: {hoverEntry.categories_firing}/3</span>
            <span className="text-zinc-500">5d: {hoverEntry.categories_firing_5d}/4</span>
            <span className="text-zinc-500">signals: {hoverEntry.signals_firing}</span>
          </div>
        ) : (
          <div className="text-[10px] font-mono text-zinc-700">— hover to inspect —</div>
        )}
      </div>

      <div className="p-3">
        <svg
          viewBox={`0 0 ${rows.length} 32`}
          preserveAspectRatio="none"
          className="w-full h-24"
          onMouseLeave={() => setHoverIdx(null)}
        >
          {/* Sparkline lane: y in [0, 10]. Bar height = (cats / maxCats) * 10. */}
          {rows.map((r, i) => {
            const h = (r.categories_firing / maxCats) * 10;
            return (
              <rect
                key={`s${i}`}
                x={i}
                y={10 - h}
                width={1}
                height={h}
                className="fill-cyan-300/60"
              />
            );
          })}
          {/* Separator line */}
          <line x1={0} y1={11} x2={rows.length} y2={11} className="stroke-zinc-800" strokeWidth={0.2} />
          {/* Heatmap row: y in [12, 32]. */}
          {rows.map((r, i) => (
            <rect
              key={`h${i}`}
              x={i}
              y={12}
              width={1}
              height={20}
              className={REGIME_FILL[r.regime]}
            />
          ))}
          {/* Hover capture row (transparent, full height) */}
          {rows.map((_, i) => (
            <rect
              key={`c${i}`}
              x={i}
              y={0}
              width={1}
              height={32}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
              style={{ pointerEvents: 'all' }}
            />
          ))}
        </svg>
        <div className="flex items-center gap-3 mt-2 text-[9px] font-mono uppercase tracking-[0.15em]">
          {(['green','yellow','orange','red'] as Regime[]).map(k => (
            <span key={k} className="flex items-center gap-1">
              <span className={`w-2 h-2 rounded-sm ${REGIME_FILL[k].replace('fill-', 'bg-')}`} />
              <span className={REGIME_TEXT[k]}>{k}</span>
            </span>
          ))}
          <span className="ml-auto text-zinc-600">
            sparkline 0..{maxCats} · heatmap colored by regime
          </span>
        </div>
      </div>
    </div>
  );
}
