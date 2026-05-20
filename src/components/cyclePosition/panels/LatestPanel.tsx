/**
 * Latest snapshot panel — Panel A.
 *
 * Large phase-colored hero block with the current score, phase label, and
 * 12-month recession probability. Mirrors the morning-brief section #7
 * top-line read so the dashboard and the brief stay in lockstep.
 *
 * SPEC: docs/specs/market-cycle-position.md §3 (component diagram, dashboard
 * panel branch), §6 (function signatures).
 */
import type { CyclePositionLatestPayload } from '../../../server/cycle_position_dashboard.js';

type Phase = 'early' | 'mid' | 'late' | 'contraction' | 'unknown';

const PHASE_BG: Record<Phase, string> = {
  early:        'bg-emerald-500/20 border-emerald-400/60',
  mid:          'bg-cyan-500/15 border-cyan-400/50',
  late:         'bg-orange-500/25 border-orange-400/70',
  contraction:  'bg-red-500/30 border-red-400/70',
  unknown:      'bg-zinc-500/15 border-zinc-500/50',
};

const PHASE_TEXT: Record<Phase, string> = {
  early:        'text-emerald-200',
  mid:          'text-cyan-200',
  late:         'text-orange-200',
  contraction:  'text-red-200',
  unknown:      'text-zinc-300',
};

const PHASE_LABEL: Record<Phase, string> = {
  early:        'EARLY — recovery / expansion',
  mid:          'MID — no clear directional signal',
  late:         'LATE — multiple inputs softening',
  contraction:  'CONTRACTION — recession near / here',
  unknown:      'UNKNOWN — yield-curve input missing',
};

/** Friendly read on the recession probability tier. */
function recessionReading(p: number): string {
  if (p < 15) return 'low';
  if (p < 30) return 'elevated';
  if (p < 50) return 'high';
  return 'critical';
}

export function LatestPanel({
  latest,
  historyLen,
}: {
  latest: CyclePositionLatestPayload;
  historyLen: number;
}) {
  const phase = (latest.phaseLabel as Phase) in PHASE_BG
    ? (latest.phaseLabel as Phase)
    : 'unknown';
  const score = latest.score;
  const prob = latest.recessionProbPct;
  const inputsCount = popcount(latest.inputsPresent);
  const probTier = recessionReading(prob);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr_1fr] gap-3">
      {/* Hero — phase + score */}
      <div className={`border-2 rounded p-5 flex flex-col justify-between ${PHASE_BG[phase]}`}>
        <div>
          <div className="text-[9px] font-black uppercase tracking-[0.25em] text-white/60 mb-2">
            Current cycle phase
          </div>
          <div className={`text-3xl lg:text-4xl font-black ${PHASE_TEXT[phase]} mb-1`}>
            {PHASE_LABEL[phase]}
          </div>
          <div className={`text-[11px] font-mono ${PHASE_TEXT[phase]}/80 mb-3`}>
            score {score.toFixed(3)} / 1.000{'  '}
            <span className="text-white/40">
              · bands: contraction&lt;0.20 · late&lt;0.40 · mid&lt;0.65 · early≥0.65
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between text-[10px] font-mono text-white/50 mt-2 pt-2 border-t border-white/10">
          <span>snapshot {latest.snapshotDate}</span>
          <span>composite {latest.compositeVersion}</span>
        </div>
      </div>

      {/* Recession probability */}
      <div className="border border-[#1a1a1a] bg-black rounded p-4 flex flex-col gap-2">
        <div className="text-[9px] font-black uppercase tracking-[0.25em] text-zinc-400">
          12-month recession prob
        </div>
        <div className="text-3xl font-mono text-white">{prob.toFixed(1)}%</div>
        <div className="text-[10px] font-mono text-zinc-500">
          tier: <span className={
            probTier === 'critical' ? 'text-red-300' :
            probTier === 'high' ? 'text-orange-300' :
            probTier === 'elevated' ? 'text-yellow-300' :
            'text-emerald-300'
          }>{probTier}</span>
        </div>
        <div className="text-[9px] font-mono text-zinc-600 mt-auto leading-snug">
          Estrella-Mishkin 1998 logit on T10Y3M. Local approximation;
          Phase B compares to NY Fed published series.
        </div>
      </div>

      {/* Inputs present diagnostic */}
      <div className="border border-[#1a1a1a] bg-black rounded p-4 flex flex-col gap-2">
        <div className="text-[9px] font-black uppercase tracking-[0.25em] text-zinc-400">
          Inputs present
        </div>
        <div className="text-3xl font-mono text-white">{inputsCount}<span className="text-zinc-500 text-2xl">/8</span></div>
        <div className="text-[10px] font-mono text-zinc-500 break-all">
          bitmask 0b{latest.inputsPresent.toString(2).padStart(8, '0')}
        </div>
        <div className="text-[9px] font-mono text-zinc-600 mt-auto leading-snug">
          {inputsCount === 8
            ? 'full-confidence read · all bucket inputs present'
            : inputsCount >= 4
              ? 'partial-confidence read · some inputs missing'
              : 'degraded read · score relies on a minority of inputs'}
          {' · '}{historyLen}d loaded
        </div>
      </div>
    </div>
  );
}

function popcount(n: number): number {
  let count = 0;
  let x = n;
  while (x > 0) { count += x & 1; x = x >>> 1; }
  return count;
}
