/**
 * Regime distribution table — Panel E.
 *
 * Counts of red/orange/yellow/green over the windowed lookback, 1Y, 5Y,
 * all-time, vs the ADR-037 baseline. The "Δ vs baseline" row in pp answers
 * "is this period regime-stressful by historical standards?"
 *
 * SPEC: docs/specs/regime-dashboard-component3.md §3.3 (Panel E).
 */
import type { RegimeCounts, RegimeDistribution } from '../../../server/regime_dashboard.js';
import type { Regime } from '../../../server/macro_regime.js';

const REGIME_HEAD: Record<Regime, string> = {
  red:    'text-red-300',
  orange: 'text-orange-300',
  yellow: 'text-yellow-300',
  green:  'text-emerald-300',
};

const ORDER: Regime[] = ['red', 'orange', 'yellow', 'green'];

function fmtCount(c: number, pct: number): string {
  return `${c.toLocaleString()} (${pct.toFixed(1)}%)`;
}

function deviationColor(pp: number): string {
  if (pp > 1) return 'text-red-300';
  if (pp < -1) return 'text-emerald-300';
  return 'text-zinc-400';
}

function fmtDev(pp: number): string {
  const s = pp >= 0 ? '+' : '';
  return `${s}${pp.toFixed(2)} pp`;
}

function row(
  label: string,
  detail: string,
  counts: RegimeCounts,
  pct: RegimeCounts,
  tradingDays: number,
  emphasized = false,
) {
  return (
    <tr className={`border-t border-[#1a1a1a] ${emphasized ? 'bg-amber-500/[0.04]' : ''}`}>
      <td className="px-3 py-2">
        <div className={`text-[11px] font-mono ${emphasized ? 'text-amber-200' : 'text-white'}`}>{label}</div>
        <div className="text-[9px] font-mono text-zinc-600">{detail}</div>
      </td>
      {ORDER.map(k => (
        <td key={k} className={`px-3 py-2 text-right text-[11px] font-mono ${REGIME_HEAD[k]}`}>
          {fmtCount(counts[k], pct[k])}
        </td>
      ))}
      <td className="px-3 py-2 text-right text-[10px] font-mono text-zinc-500">
        {tradingDays.toLocaleString()}
      </td>
    </tr>
  );
}

export function DistributionTable({ distribution }: { distribution: RegimeDistribution }) {
  const { windowed, oneYear, fiveYear, allTime, baseline, deviation } = distribution;
  return (
    <div className="border border-[#1a1a1a] bg-black rounded">
      <div className="border-b border-[#1a1a1a] px-3 py-2">
        <div className="text-xs font-black uppercase tracking-[0.2em] text-white">
          Regime distribution
        </div>
        <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
          Counts (% of window) vs the ADR-037 baseline. Δ row in percentage points.
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-[#0a0a0a]">
            <tr className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500">
              <th className="px-3 py-1.5 text-left">Window</th>
              {ORDER.map(k => (
                <th key={k} className={`px-3 py-1.5 text-right ${REGIME_HEAD[k]}`}>{k}</th>
              ))}
              <th className="px-3 py-1.5 text-right">Trading days</th>
            </tr>
          </thead>
          <tbody>
            {row(
              `Windowed`,
              `last ${windowed.lookbackDays ?? '?'} requested`,
              windowed.counts, windowed.pct, windowed.tradingDays,
            )}
            {row('Last 1Y', '~252 trading days', oneYear.counts, oneYear.pct, oneYear.tradingDays)}
            {row('Last 5Y', '~1260 trading days', fiveYear.counts, fiveYear.pct, fiveYear.tradingDays)}
            {row('All-time (phase1_v2)', 'every classified row', allTime.counts, allTime.pct, allTime.tradingDays)}
            {row('Baseline (ADR-037)', 'verified 2026-05-10', baseline.counts, baseline.pct, baseline.tradingDays, true)}
            <tr className="border-t border-[#1a1a1a] bg-zinc-900/30">
              <td className="px-3 py-2">
                <div className="text-[11px] font-mono text-zinc-300">Δ windowed vs baseline</div>
                <div className="text-[9px] font-mono text-zinc-600">percentage points (signed)</div>
              </td>
              {ORDER.map(k => (
                <td key={k} className={`px-3 py-2 text-right text-[11px] font-mono ${deviationColor(deviation[k])}`}>
                  {fmtDev(deviation[k])}
                </td>
              ))}
              <td className="px-3 py-2 text-right text-[10px] font-mono text-zinc-700">—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
