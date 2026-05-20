/**
 * Per-bucket contributions panel — Panel B.
 *
 * Three horizontal bars (yield curve, credit, employment) showing each
 * bucket's current contribution to the composite score. Bucket weights
 * are equal (1/3 each) per SPEC §7 cycle_v1; the bar value is the bucket
 * sub-score in [0, 1], not the weighted contribution to the final score.
 * A null bucket means the inputs for that bucket were missing this
 * snapshot — shown as a hatched bar with "inputs missing" label rather
 * than zero (zero would lie about the reading).
 *
 * SPEC: docs/specs/market-cycle-position.md §7 (composite weighting).
 */
import type { CyclePositionLatestPayload } from '../../../server/cycle_position_dashboard.js';

interface BucketRow {
  label: string;
  contribution: number | null;
  inputs: string;
  note: string;
}

/** Map a [0, 1] sub-score to a reading. Bands mirror the morning-brief
 *  renderer (operator_brief_render.ts §7) so the two stay in lockstep. */
function reading(c: number): { label: string; color: string } {
  if (c >= 0.65) return { label: 'expansionary', color: 'text-emerald-300' };
  if (c >= 0.40) return { label: 'neutral',      color: 'text-cyan-300' };
  if (c >= 0.20) return { label: 'softening',    color: 'text-yellow-300' };
  return { label: 'stressed',                    color: 'text-red-300' };
}

function barFill(c: number): string {
  if (c >= 0.65) return 'bg-emerald-500/60';
  if (c >= 0.40) return 'bg-cyan-500/60';
  if (c >= 0.20) return 'bg-yellow-500/60';
  return 'bg-red-500/60';
}

export function ContributionsPanel({ latest }: { latest: CyclePositionLatestPayload }) {
  const rows: BucketRow[] = [
    {
      label: 'Yield curve',
      contribution: latest.contributions.yieldCurve,
      inputs: 'T10Y3M',
      note: 'Estrella-Mishkin 1998 — 10Y-3M spread is the single best leading recession indicator.',
    },
    {
      label: 'Credit',
      contribution: latest.contributions.credit,
      inputs: 'BAA10Y · HY OAS',
      note: 'BAA-Treasury spread + ICE BofA HY option-adjusted spread (averaged).',
    },
    {
      label: 'Employment',
      contribution: latest.contributions.employment,
      inputs: 'UNRATE 12m Δ · ICSA 4w-MA z',
      note: 'Sahm-style unemployment delta + initial-claims z-score.',
    },
  ];

  return (
    <div className="border border-[#1a1a1a] bg-black rounded">
      <div className="border-b border-[#1a1a1a] px-3 py-2">
        <div className="text-xs font-black uppercase tracking-[0.2em] text-white">
          Per-bucket contributions
        </div>
        <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
          Each bucket weighted 1/3 (cycle_v1, SPEC §7). Bar value is bucket
          sub-score in [0, 1]; null = inputs missing this snapshot.
        </div>
      </div>

      <div className="p-4 grid grid-cols-1 gap-3">
        {rows.map(row => {
          if (row.contribution === null) {
            return (
              <div key={row.label} className="grid grid-cols-[140px_1fr_120px] gap-3 items-center">
                <div>
                  <div className="text-[11px] font-mono text-white">{row.label}</div>
                  <div className="text-[9px] font-mono text-zinc-600 mt-0.5">{row.inputs}</div>
                </div>
                <div className="h-6 rounded border border-zinc-800"
                     style={{
                       backgroundImage: `repeating-linear-gradient(45deg, rgba(115,115,115,0.08), rgba(115,115,115,0.08) 4px, rgba(82,82,82,0.18) 4px, rgba(82,82,82,0.18) 5px)`,
                     }}
                     title="Bucket inputs missing this snapshot"
                />
                <div className="text-right text-[10px] font-mono text-zinc-600 italic">inputs missing</div>
              </div>
            );
          }
          const c = row.contribution;
          const r = reading(c);
          const pct = Math.round(c * 1000) / 10;
          return (
            <div key={row.label} className="grid grid-cols-[140px_1fr_120px] gap-3 items-center">
              <div>
                <div className="text-[11px] font-mono text-white">{row.label}</div>
                <div className="text-[9px] font-mono text-zinc-600 mt-0.5">{row.inputs}</div>
              </div>
              <div className="h-6 rounded border border-zinc-800 relative overflow-hidden bg-zinc-900/50"
                   title={row.note}
              >
                <div
                  className={`absolute left-0 top-0 bottom-0 ${barFill(c)} transition-all`}
                  style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                />
                <div className="absolute inset-0 flex items-center px-2 text-[10px] font-mono text-white/85">
                  {c.toFixed(3)}
                </div>
              </div>
              <div className={`text-right text-[10px] font-mono ${r.color}`}>{r.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
