/**
 * Score trend panel — Panel C.
 *
 * SVG line chart of cycle-position score over the loaded window. Phase-band
 * background fills (contraction / late / mid / early) make it obvious when
 * the score crossed a phase boundary. Hover surfaces the day's score + phase
 * + per-bucket contributions.
 *
 * Decision supported: "is today's reading a local fluctuation or a sustained
 * trend?" — a single point doesn't tell us; the 365d slope does.
 *
 * SPEC: docs/specs/market-cycle-position.md §3 (component diagram, dashboard
 * panel branch). Phase bands per SPEC §6.
 */
import { useMemo, useState } from 'react';
import type { CyclePositionHistoryRow } from '../../../server/cycle_position_repository.js';

const PHASE_BAND_CONTRACTION = 0.20;
const PHASE_BAND_LATE = 0.40;
const PHASE_BAND_MID = 0.65;

// SVG viewport. Score axis: 0..1 maps to y=PLOT_BOTTOM..PLOT_TOP. Wider on
// purpose so the trend's slope is the first thing the eye picks up.
const VIEW_W = 1000;
const VIEW_H = 220;
const PLOT_TOP = 12;
const PLOT_BOTTOM = 200;
const PLOT_LEFT = 40;
const PLOT_RIGHT = 990;

export function ScoreTrendPanel({
  history,
  latestScore,
}: {
  history: CyclePositionHistoryRow[];
  latestScore: number;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const len = history.length;
  const span = useMemo(() => {
    if (len === 0) return { start: '—', end: '—' };
    return { start: history[0].snapshotDate, end: history[len - 1].snapshotDate };
  }, [history, len]);

  if (len === 0) {
    return (
      <div className="border border-[#1a1a1a] bg-black rounded p-6 text-center text-[11px] font-mono text-zinc-500">
        No history rows — `quantlab.cycle_position_snapshots` returned 0 rows for the window.
      </div>
    );
  }

  // Score in [0, 1] → y. Higher score = higher in plot.
  const scoreToY = (s: number) =>
    PLOT_BOTTOM - s * (PLOT_BOTTOM - PLOT_TOP);

  // Even spacing — one column per row. We could space by snapshot_date, but
  // the daemon writes one row per trading day and the irregular gaps would
  // make the visual misleading at panel resolution.
  const xStep = len > 1 ? (PLOT_RIGHT - PLOT_LEFT) / (len - 1) : 0;
  const idxToX = (i: number) => PLOT_LEFT + i * xStep;

  // Polyline points.
  const pointsAttr = history
    .map((r, i) => `${idxToX(i).toFixed(2)},${scoreToY(r.score).toFixed(2)}`)
    .join(' ');

  const hover = hoverIdx != null ? history[hoverIdx] : null;

  return (
    <div className="border border-[#1a1a1a] bg-black rounded">
      <div className="border-b border-[#1a1a1a] px-3 py-2 flex items-center justify-between">
        <div>
          <div className="text-xs font-black uppercase tracking-[0.2em] text-white">
            Score trend · {len} snapshot{len === 1 ? '' : 's'}
          </div>
          <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
            {span.start} → {span.end} · hover for per-day detail · phase bands per SPEC §6
          </div>
        </div>
        {hover ? (
          <div className="flex items-center gap-3 text-[10px] font-mono">
            <span className="text-zinc-400">{hover.snapshotDate}</span>
            <span className="text-white">score {hover.score.toFixed(3)}</span>
            <span className={
              hover.phaseLabel === 'early'       ? 'text-emerald-300' :
              hover.phaseLabel === 'mid'         ? 'text-cyan-300' :
              hover.phaseLabel === 'late'        ? 'text-orange-300' :
              hover.phaseLabel === 'contraction' ? 'text-red-300' :
                                                    'text-zinc-400'
            }>{hover.phaseLabel}</span>
            <span className="text-zinc-500">prob {hover.recessionProbPct.toFixed(1)}%</span>
          </div>
        ) : (
          <div className="text-[10px] font-mono">
            <span className="text-zinc-700">— hover to inspect ·</span>{' '}
            <span className="text-white">latest {latestScore.toFixed(3)}</span>
          </div>
        )}
      </div>

      <div className="p-3">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="w-full h-56"
          onMouseLeave={() => setHoverIdx(null)}
        >
          {/* Phase-band backgrounds */}
          <rect
            x={PLOT_LEFT} width={PLOT_RIGHT - PLOT_LEFT}
            y={scoreToY(1)} height={scoreToY(PHASE_BAND_MID) - scoreToY(1)}
            className="fill-emerald-500/8"
          />
          <rect
            x={PLOT_LEFT} width={PLOT_RIGHT - PLOT_LEFT}
            y={scoreToY(PHASE_BAND_MID)}
            height={scoreToY(PHASE_BAND_LATE) - scoreToY(PHASE_BAND_MID)}
            className="fill-cyan-500/8"
          />
          <rect
            x={PLOT_LEFT} width={PLOT_RIGHT - PLOT_LEFT}
            y={scoreToY(PHASE_BAND_LATE)}
            height={scoreToY(PHASE_BAND_CONTRACTION) - scoreToY(PHASE_BAND_LATE)}
            className="fill-orange-500/10"
          />
          <rect
            x={PLOT_LEFT} width={PLOT_RIGHT - PLOT_LEFT}
            y={scoreToY(PHASE_BAND_CONTRACTION)}
            height={scoreToY(0) - scoreToY(PHASE_BAND_CONTRACTION)}
            className="fill-red-500/10"
          />

          {/* Y-axis grid lines + labels at phase bands */}
          {[0, PHASE_BAND_CONTRACTION, PHASE_BAND_LATE, PHASE_BAND_MID, 1].map(v => (
            <g key={v}>
              <line
                x1={PLOT_LEFT} y1={scoreToY(v)}
                x2={PLOT_RIGHT} y2={scoreToY(v)}
                className="stroke-zinc-800"
                strokeWidth={0.5}
                strokeDasharray="2 3"
              />
              <text
                x={PLOT_LEFT - 6} y={scoreToY(v) + 3}
                textAnchor="end"
                className="fill-zinc-500"
                fontSize={9}
                fontFamily="monospace"
              >
                {v.toFixed(2)}
              </text>
            </g>
          ))}

          {/* The line itself */}
          <polyline
            points={pointsAttr}
            fill="none"
            className="stroke-cyan-300"
            strokeWidth={1.2}
            vectorEffect="non-scaling-stroke"
          />

          {/* Last-point highlight */}
          <circle
            cx={idxToX(len - 1)}
            cy={scoreToY(history[len - 1].score)}
            r={3}
            className="fill-cyan-200 stroke-cyan-400"
            strokeWidth={1}
          />

          {/* Hover dot */}
          {hoverIdx !== null && (
            <>
              <line
                x1={idxToX(hoverIdx)} y1={PLOT_TOP}
                x2={idxToX(hoverIdx)} y2={PLOT_BOTTOM}
                className="stroke-white/30"
                strokeWidth={0.5}
                strokeDasharray="2 2"
              />
              <circle
                cx={idxToX(hoverIdx)}
                cy={scoreToY(history[hoverIdx].score)}
                r={3}
                className="fill-white stroke-cyan-300"
                strokeWidth={1}
              />
            </>
          )}

          {/* Hover capture columns — narrow rectangles for each datapoint */}
          {history.map((_, i) => {
            const x = idxToX(i);
            const colW = Math.max(2, xStep);
            return (
              <rect
                key={i}
                x={x - colW / 2}
                y={PLOT_TOP}
                width={colW}
                height={PLOT_BOTTOM - PLOT_TOP}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(i)}
                style={{ pointerEvents: 'all' }}
              />
            );
          })}
        </svg>
        <div className="flex items-center gap-4 mt-2 text-[9px] font-mono uppercase tracking-[0.15em]">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-emerald-500/30" />
            <span className="text-emerald-300">early ≥ 0.65</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-cyan-500/30" />
            <span className="text-cyan-300">mid 0.40-0.65</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-orange-500/30" />
            <span className="text-orange-300">late 0.20-0.40</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-red-500/30" />
            <span className="text-red-300">contraction &lt; 0.20</span>
          </span>
          <span className="ml-auto text-zinc-600">
            phase bands per SPEC §6 · re-tune = cycle_v2 bump
          </span>
        </div>
      </div>
    </div>
  );
}
