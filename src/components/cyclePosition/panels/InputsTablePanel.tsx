/**
 * Inputs table panel — Panel D.
 *
 * Surfaces the raw FRED inputs underpinning the composite — today's reading,
 * the reading at the start of the loaded window, and the delta. Sign +
 * coloring follow the recession-direction convention (higher curve spread =
 * better; higher credit spread = worse; higher claims-z = worse), NOT the
 * raw arithmetic sign of the delta. This is the panel an operator opens
 * when they want to know which input moved.
 *
 * SPEC: docs/specs/market-cycle-position.md §3 (component diagram),
 * §7 (composite weighting — sign conventions per bucket).
 */
import type { CyclePositionLatestPayload } from '../../../server/cycle_position_dashboard.js';
import type { CyclePositionHistoryRow } from '../../../server/cycle_position_repository.js';

type Direction = 'higher-is-better' | 'higher-is-worse';

interface InputRow {
  label: string;
  series: string;
  unit: string;
  current: number | null;
  start: number | null;
  direction: Direction;
  note: string;
}

function fmt(v: number | null, digits: number): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}`;
}

function deltaColor(delta: number | null, direction: Direction): string {
  if (delta == null || !Number.isFinite(delta) || delta === 0) return 'text-zinc-400';
  const goodDirection =
    direction === 'higher-is-better' ? delta > 0 : delta < 0;
  return goodDirection ? 'text-emerald-300' : 'text-red-300';
}

export function InputsTablePanel({
  latest,
  history,
}: {
  latest: CyclePositionLatestPayload;
  history: CyclePositionHistoryRow[];
}) {
  // Most recent history row is "today's reading" (the brief and dashboard
  // already converge on the same snapshot date for `latest` and the last
  // history row, but the history row also carries the per-input raw values).
  const last = history.length > 0 ? history[history.length - 1] : null;
  const first = history.length > 0 ? history[0] : null;

  const rows: InputRow[] = [
    {
      label: 'T10Y3M spread',
      series: 'T10Y3M',
      unit: '%',
      current: last?.inputs.t10y3m ?? null,
      start: first?.inputs.t10y3m ?? null,
      direction: 'higher-is-better',
      note: 'PRIMARY yield-curve signal. Estrella-Mishkin 1998; NY Fed Current Issues 2006.',
    },
    {
      label: 'T10Y2Y spread',
      series: 'T10Y2Y',
      unit: '%',
      current: last?.inputs.t10y2y ?? null,
      start: first?.inputs.t10y2y ?? null,
      direction: 'higher-is-better',
      note: 'Logged for cross-check; NOT weighted into score in cycle_v1.',
    },
    {
      label: 'BAA-10Y spread',
      series: 'BAA10Y',
      unit: '%',
      current: last?.inputs.baa10y ?? null,
      start: first?.inputs.baa10y ?? null,
      direction: 'higher-is-worse',
      note: 'Slow-credit. Healthy ≤ 1.5%; stressed ≥ 4.0%.',
    },
    {
      label: 'HY OAS',
      series: 'BAMLH0A0HYM2',
      unit: '%',
      current: last?.inputs.hyOas ?? null,
      start: first?.inputs.hyOas ?? null,
      direction: 'higher-is-worse',
      note: 'Fast-credit. Healthy ≤ 3%; stressed ≥ 8%. FRED ~3y limit on free history.',
    },
    {
      label: 'Unemployment',
      series: 'UNRATE',
      unit: '%',
      current: last?.inputs.unrate ?? null,
      start: first?.inputs.unrate ?? null,
      direction: 'higher-is-worse',
      note: 'Current rate; logged. Not directly weighted — Δ12m below is.',
    },
    {
      label: 'UNRATE Δ12m',
      series: 'derived',
      unit: 'pp',
      current: last?.inputs.unrate12mChange ?? null,
      start: first?.inputs.unrate12mChange ?? null,
      direction: 'higher-is-worse',
      note: 'Sahm-style trend. Healthy ≤ −0.3pp; stressed ≥ +0.5pp.',
    },
    {
      label: 'Claims 4w-MA z',
      series: 'derived',
      unit: 'σ',
      current: last?.inputs.claims4wMaZscore ?? null,
      start: first?.inputs.claims4wMaZscore ?? null,
      direction: 'higher-is-worse',
      note: 'z vs trailing 2y. Healthy ≤ −0.5; stressed ≥ +2.0.',
    },
  ];

  return (
    <div className="border border-[#1a1a1a] bg-black rounded">
      <div className="border-b border-[#1a1a1a] px-3 py-2 flex items-center justify-between">
        <div>
          <div className="text-xs font-black uppercase tracking-[0.2em] text-white">
            Raw inputs · current vs window start
          </div>
          <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
            Sign of Δ colored by recession direction, not raw arithmetic.
            ‘—’ = series missing for that snapshot.
          </div>
        </div>
        <div className="text-[10px] font-mono text-zinc-500">
          {history.length > 0
            ? `${history[0].snapshotDate} → ${latest.snapshotDate}`
            : 'no window data'}
        </div>
      </div>

      <div className="p-3">
        <table className="w-full">
          <thead>
            <tr>
              <th className="text-left text-[9px] font-black uppercase tracking-[0.15em] text-zinc-500 pb-2 pr-2">input</th>
              <th className="text-left text-[9px] font-black uppercase tracking-[0.15em] text-zinc-500 pb-2 pr-2">series</th>
              <th className="text-right text-[9px] font-black uppercase tracking-[0.15em] text-zinc-500 pb-2 pr-2">window start</th>
              <th className="text-right text-[9px] font-black uppercase tracking-[0.15em] text-zinc-500 pb-2 pr-2">current</th>
              <th className="text-right text-[9px] font-black uppercase tracking-[0.15em] text-zinc-500 pb-2">Δ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const delta =
                row.current != null && row.start != null && Number.isFinite(row.current) && Number.isFinite(row.start)
                  ? row.current - row.start
                  : null;
              const digits = row.unit === 'pp' || row.unit === 'σ' ? 2 : 2;
              return (
                <tr key={row.label} className="border-t border-[#1a1a1a]" title={row.note}>
                  <td className="py-1.5 pr-2">
                    <div className="text-[11px] font-mono text-white">{row.label}</div>
                    <div className="text-[9px] font-mono text-zinc-600">
                      {row.direction === 'higher-is-better' ? '↑ = healthier' : '↑ = more stressed'}
                    </div>
                  </td>
                  <td className="py-1.5 pr-2">
                    <code className="text-[10px] font-mono text-zinc-400">{row.series}</code>
                  </td>
                  <td className="py-1.5 pr-2 text-right text-[11px] font-mono text-zinc-300">
                    {row.start != null && Number.isFinite(row.start)
                      ? `${row.start.toFixed(digits)}${row.unit === '%' ? '%' : row.unit === 'pp' ? 'pp' : row.unit === 'σ' ? 'σ' : ''}`
                      : '—'}
                  </td>
                  <td className="py-1.5 pr-2 text-right text-[11px] font-mono text-white">
                    {row.current != null && Number.isFinite(row.current)
                      ? `${row.current.toFixed(digits)}${row.unit === '%' ? '%' : row.unit === 'pp' ? 'pp' : row.unit === 'σ' ? 'σ' : ''}`
                      : '—'}
                  </td>
                  <td className={`py-1.5 text-right text-[11px] font-mono ${deltaColor(delta, row.direction)}`}>
                    {delta != null ? fmt(delta, digits) : '—'}
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
