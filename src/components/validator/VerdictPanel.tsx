/**
 * Panel 2 — VERDICT_LIGHTS.
 * The headline. Four colored gates + the server-built sentence ("3 of 4 gates pass").
 *
 * Status colors are project tokens (emerald/red/yellow/gray) — same palette as the
 * existing dashboard's status indicators in App.tsx.
 */

import type { ValidatorResult, GateOutcome } from '../../lib/validator';

interface Props {
  result: ValidatorResult | null;
  errorMessage?: string | null;
}

const STATUS_TOKENS: Record<GateOutcome['status'], { dot: string; ring: string; text: string; bg: string; label: string }> = {
  pass: {
    dot: 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.7)]',
    ring: 'border-emerald-400/40',
    text: 'text-emerald-400',
    bg: 'bg-emerald-500/[0.06]',
    label: 'PASS',
  },
  fail: {
    dot: 'bg-red-400 shadow-[0_0_10px_rgba(248,113,113,0.7)]',
    ring: 'border-red-400/40',
    text: 'text-red-400',
    bg: 'bg-red-500/[0.06]',
    label: 'FAIL',
  },
  na: {
    dot: 'bg-gray-600',
    ring: 'border-gray-700',
    text: 'text-gray-500',
    bg: 'bg-[#0a0a0a]',
    label: 'N/A',
  },
};

const VERDICT_TOKENS: Record<ValidatorResult['verdict'], { text: string; chip: string }> = {
  'pass-all': { text: 'text-emerald-400', chip: 'bg-emerald-500/10 border-emerald-400/40' },
  'partial': { text: 'text-yellow-400', chip: 'bg-yellow-500/10 border-yellow-400/40' },
  'fail-all': { text: 'text-red-400', chip: 'bg-red-500/10 border-red-400/40' },
  'insufficient-input': { text: 'text-gray-500', chip: 'bg-[#0a0a0a] border-[#222]' },
};

export function VerdictPanel({ result, errorMessage }: Props) {
  if (errorMessage) {
    return (
      <div className="bg-[#0a0a0a] rounded-2xl border border-red-500/40 p-5">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1.5 h-1.5 rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]" />
          <p className="text-[9px] font-black text-red-400 uppercase tracking-[0.2em]">Verdict_Lights</p>
        </div>
        <p className="text-[11px] font-mono text-red-400">{errorMessage}</p>
      </div>
    );
  }
  if (!result) {
    return (
      <div className="bg-[#0a0a0a] rounded-2xl border border-[#1a1a1a] p-5">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1.5 h-1.5 rounded-full bg-gray-700" />
          <p className="text-[9px] font-black text-gray-600 uppercase tracking-[0.2em]">Verdict_Lights</p>
        </div>
        <p className="text-[11px] font-mono text-gray-700 italic">
          Submit a strategy to see the four-gate verdict.
        </p>
      </div>
    );
  }

  const v = VERDICT_TOKENS[result.verdict];
  const gates = [
    { id: 'dsr', g: result.gates.dsr },
    { id: 'oosIs', g: result.gates.oosIs },
    { id: 'hlz', g: result.gates.hlz },
    { id: 'pbo', g: result.gates.pbo },
  ];

  return (
    <div className="bg-[#0a0a0a] rounded-2xl border border-[#1a1a1a] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 shadow-[0_0_6px_rgba(250,204,21,0.5)]" />
          <p className="text-[9px] font-black text-yellow-400 uppercase tracking-[0.2em]">Verdict_Lights</p>
        </div>
        <span className={`text-[9px] font-mono uppercase tracking-widest border rounded px-2 py-0.5 ${v.chip} ${v.text}`}>
          {result.verdict.replace('-', ' ')}
        </span>
      </div>

      <p className={`text-base font-black tracking-tight ${v.text}`}>
        {result.headlineSentence}
      </p>

      <div className="grid grid-cols-4 gap-2">
        {gates.map(({ id, g }) => {
          const t = STATUS_TOKENS[g.status];
          const pretty = formatValue(g.value, g.label);
          return (
            <div key={id} className={`rounded-xl border ${t.ring} ${t.bg} p-3 space-y-1.5`}>
              <div className="flex items-center justify-between">
                <span className={`text-[9px] font-black uppercase tracking-widest ${t.text}`}>{g.label}</span>
                <span className={`w-2 h-2 rounded-full ${t.dot}`} />
              </div>
              <div className="space-y-0.5">
                <p className={`text-lg font-mono font-bold tracking-tight ${t.text}`}>
                  {pretty}
                </p>
                <p className="text-[8px] font-mono text-gray-600">
                  {g.status === 'na' ? 'gate not runnable' : `gate ${formatGate(g.label, g.threshold)}`}
                </p>
              </div>
              <div className={`text-[8px] font-black uppercase tracking-widest ${t.text}`}>
                {t.label}
              </div>
            </div>
          );
        })}
      </div>

      {/* Context strip — chosen rank, N trials, bar counts. Bloomberg density. */}
      <div className="grid grid-cols-5 gap-2 text-[9px] font-mono border-t border-[#1a1a1a] pt-3">
        <Stat label="Trials" value={String(result.context.nTrials)} />
        <Stat label="After filter" value={String(result.context.nTrialsAfterSparseFilter)} />
        <Stat label="Chosen rank" value={`${result.context.chosenTrialRank}/${result.context.nTrials}`} />
        <Stat label="Sharpe" value={result.context.chosenSharpe.toFixed(3)} />
        <Stat label="IS / OOS bars" value={`${result.context.isBars}/${result.context.oosBars}`} />
      </div>

      {result.warnings.length > 0 && (
        <ul className="space-y-1 text-[10px] font-mono text-yellow-300/90 bg-yellow-500/5 border border-yellow-500/20 rounded-lg p-2">
          {result.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[7px] font-bold text-gray-700 uppercase tracking-widest">{label}</p>
      <p className="text-yellow-300/90">{value}</p>
    </div>
  );
}

function formatValue(value: number | null, label: string): string {
  if (value === null) return '—';
  if (label.startsWith('HLZ')) return value.toFixed(2);  // t-stat
  return value.toFixed(3);
}

function formatGate(label: string, threshold: number): string {
  if (label === 'DSR') return `≥ ${threshold.toFixed(2)}`;
  if (label === 'PBO') return `< ${threshold.toFixed(2)}`;
  if (label === 'OOS/IS') return `≥ ${threshold.toFixed(2)}`;
  if (label.startsWith('HLZ')) return `t ≥ crit`;
  return `${threshold}`;
}
