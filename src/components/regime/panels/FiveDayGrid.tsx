/**
 * 5-day rolling-union grid — Panel D.
 *
 * 4 rows (vix_term_inverted / hyg_spy_divergence / breadth_narrow /
 * realized_stress) × up-to-5 columns (oldest to today). Each cell is filled
 * if the indicator fired that day. The realized_stress row is rendered with
 * grey hatching to show "structurally dark, not absent" under phase1_v2.
 *
 * The "5d categories union: N/4" caption summarizes the count that drives
 * the `red` rule — Phase 1 SPEC §2.4 + Phase 2 SPEC §2.3.
 *
 * Decision supported: is today's label fragile (one signal away from `red`)
 * or robust?
 *
 * SPEC: docs/specs/regime-dashboard-component3.md §3.3 (Panel D).
 */
import type { FiveDayWindowEntry } from '../../../server/regime_dashboard.js';

interface IndicatorRowDef {
  key: keyof Pick<
    FiveDayWindowEntry,
    'vix_term_inverted' | 'hyg_spy_divergence' | 'breadth_narrow' | 'realized_stress'
  >;
  label: string;
  category: string;
  dark?: boolean;
}

const INDICATORS: IndicatorRowDef[] = [
  { key: 'vix_term_inverted',  label: 'vix_term_inverted',  category: 'vol' },
  { key: 'hyg_spy_divergence', label: 'hyg_spy_divergence', category: 'credit' },
  { key: 'breadth_narrow',     label: 'breadth_narrow',     category: 'breadth' },
  { key: 'realized_stress',    label: 'realized_stress',    category: 'stress', dark: true },
];

export function FiveDayGrid({ window }: { window: FiveDayWindowEntry[] }) {
  const len = window.length;
  // Pad to 5 visually, but distinguish hatch-pad cells from real-but-non-fire cells.
  const padCount = Math.max(0, 5 - len);

  // 5d category union: which categories fired in any day of the window.
  const union = {
    vol:     window.some(d => d.vix_term_inverted === 1),
    credit:  window.some(d => d.hyg_spy_divergence === 1),
    breadth: window.some(d => d.breadth_narrow === 1),
    stress:  window.some(d => d.realized_stress === 1),
  };
  const categoriesUnion = Object.values(union).filter(Boolean).length;

  return (
    <div className="border border-[#1a1a1a] bg-black rounded">
      <div className="border-b border-[#1a1a1a] px-3 py-2 flex items-center justify-between">
        <div>
          <div className="text-xs font-black uppercase tracking-[0.2em] text-white">
            5-day rolling union
          </div>
          <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
            Drives the `red` rule. {len < 5 && `Showing ${len} day${len === 1 ? '' : 's'} — warmup boundary.`}
          </div>
        </div>
        <div className="text-[10px] font-mono">
          <span className="text-zinc-500">5d categories union: </span>
          <span className={categoriesUnion >= 3 ? 'text-red-300 font-black' : 'text-zinc-300'}>
            {categoriesUnion}/4
          </span>
          <span className="text-zinc-600"> {categoriesUnion >= 3 ? '(red threshold met under §2.3)' : ''}</span>
        </div>
      </div>

      <div className="p-3">
        <table className="w-full">
          <thead>
            <tr>
              <th className="text-left text-[9px] font-black uppercase tracking-[0.15em] text-zinc-500 pb-2 pr-2">
                indicator
              </th>
              {Array.from({ length: padCount }).map((_, i) => (
                <th key={`p${i}`} className="text-center text-[9px] font-mono text-zinc-700 pb-2">
                  —
                </th>
              ))}
              {window.map(w => (
                <th key={w.date} className="text-center text-[9px] font-mono text-zinc-500 pb-2">
                  {w.date.slice(5)}
                </th>
              ))}
              <th className="text-right text-[9px] font-black uppercase tracking-[0.15em] text-zinc-500 pb-2 pl-2">
                cat fired?
              </th>
            </tr>
          </thead>
          <tbody>
            {INDICATORS.map(ind => {
              const catFired = window.some(d => d[ind.key] === 1);
              return (
                <tr key={ind.key} className="border-t border-[#1a1a1a]">
                  <td className="py-1.5 pr-2">
                    <div className="text-[11px] font-mono text-white">{ind.label}</div>
                    <div className="text-[9px] font-mono text-zinc-600">cat: {ind.category}</div>
                  </td>
                  {Array.from({ length: padCount }).map((_, i) => (
                    <td
                      key={`p${i}`}
                      className="py-1.5 px-1 text-center"
                      title="No row at this trading day (warmup boundary)"
                    >
                      <div
                        className="mx-auto h-6 w-full rounded"
                        style={{
                          backgroundImage: `repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(115,115,115,0.15) 4px, rgba(115,115,115,0.15) 5px)`,
                        }}
                      />
                    </td>
                  ))}
                  {window.map(d => {
                    const fired = d[ind.key] === 1;
                    if (ind.dark) {
                      return (
                        <td
                          key={d.date}
                          className="py-1.5 px-1 text-center"
                          title={`${d.date} · ${ind.label} structurally dark under phase1_v2`}
                        >
                          <div
                            className="mx-auto h-6 w-full rounded border border-zinc-800"
                            style={{
                              backgroundImage: `repeating-linear-gradient(45deg, rgba(115,115,115,0.08), rgba(115,115,115,0.08) 4px, rgba(82,82,82,0.18) 4px, rgba(82,82,82,0.18) 5px)`,
                            }}
                          />
                        </td>
                      );
                    }
                    return (
                      <td
                        key={d.date}
                        className="py-1.5 px-1 text-center"
                        title={`${d.date} · ${ind.label} ${fired ? 'fired' : 'clear'}`}
                      >
                        <div
                          className={`mx-auto h-6 w-full rounded border ${
                            fired
                              ? 'bg-red-500/40 border-red-400/60'
                              : 'bg-zinc-900/50 border-zinc-800'
                          }`}
                        />
                      </td>
                    );
                  })}
                  <td className="py-1.5 pl-2 text-right">
                    {ind.dark ? (
                      <span className="text-[10px] font-mono text-zinc-600 italic">dark</span>
                    ) : (
                      <span className={`text-[10px] font-mono ${catFired ? 'text-red-300' : 'text-zinc-600'}`}>
                        {catFired ? 'yes' : 'no'}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
