/**
 * Panel 3 — PER_GATE_DETAIL.
 * Per-gate intuition + math walkthrough + failure-mode + extras. The teaching panel.
 *
 * Each card is collapsed by default to keep the panel scrollable; clicking expands.
 * Source citation is the footer of each card so readers always see what they're
 * being held accountable to.
 */

import { Fragment, useState } from 'react';
import type { ValidatorResult, GateOutcome } from '../../lib/validator';

interface Props {
  result: ValidatorResult | null;
}

export function GateDetailPanel({ result }: Props) {
  if (!result) {
    return (
      <div className="bg-[#0a0a0a] rounded-2xl border border-[#1a1a1a] p-5">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1.5 h-1.5 rounded-full bg-gray-700" />
          <p className="text-[9px] font-black text-gray-600 uppercase tracking-[0.2em]">Per_Gate_Detail</p>
        </div>
        <p className="text-[11px] font-mono text-gray-700 italic">
          Submit a strategy to see the math behind each gate.
        </p>
      </div>
    );
  }

  const order: { id: string; g: GateOutcome }[] = [
    { id: 'dsr', g: result.gates.dsr },
    { id: 'oosIs', g: result.gates.oosIs },
    { id: 'hlz', g: result.gates.hlz },
    { id: 'pbo', g: result.gates.pbo },
  ];

  return (
    <div className="bg-[#0a0a0a] rounded-2xl border border-[#1a1a1a] p-5 space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 shadow-[0_0_6px_rgba(250,204,21,0.5)]" />
        <p className="text-[9px] font-black text-yellow-400 uppercase tracking-[0.2em]">Per_Gate_Detail</p>
      </div>

      <div className="space-y-2">
        {/* Fragment wrapper carries the React key — GateCard's prop type doesn't
            include `key` (project has no @types/react so React's intrinsic-attrs
            magic doesn't apply to function components). */}
        {order.map(({ id, g }) => <Fragment key={id}><GateCard gate={g} /></Fragment>)}
      </div>
    </div>
  );
}

function GateCard({ gate }: { gate: GateOutcome }) {
  const [open, setOpen] = useState(false);
  const tone =
    gate.status === 'pass' ? 'border-emerald-400/30 hover:border-emerald-400/50' :
    gate.status === 'fail' ? 'border-red-400/30 hover:border-red-400/50' :
    'border-gray-700 hover:border-gray-600';
  const dot =
    gate.status === 'pass' ? 'bg-emerald-400' :
    gate.status === 'fail' ? 'bg-red-400' :
    'bg-gray-600';
  const valText = gate.value === null
    ? '—'
    : gate.label.startsWith('HLZ')
      ? `t = ${gate.value.toFixed(3)} (crit ${gate.threshold.toFixed(3)})`
      : `${gate.value.toFixed(3)} vs gate ${gate.threshold.toFixed(2)}`;

  return (
    <div className={`rounded-xl border ${tone} bg-[#070707] transition-colors`}>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left"
      >
        <div className="flex items-center gap-2.5">
          <span className={`w-2 h-2 rounded-full ${dot}`} />
          <span className="text-[10px] font-black text-white uppercase tracking-widest">{gate.label}</span>
          <span className="text-[9px] font-mono text-gray-500">{valText}</span>
        </div>
        <span className="text-[9px] text-gray-600 font-mono">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2.5 border-t border-[#1a1a1a] pt-2.5">
          <Section label="Intuition" body={gate.intuition} />
          <Section label="Math walkthrough" body={gate.explanation} mono />
          <Section label="Failure mode" body={gate.failureMode} />
          {gate.missingInput && (
            <Section label="Missing input" body={gate.missingInput} mono tone="warn" />
          )}
          {gate.extras && Object.keys(gate.extras).length > 0 && (
            <ExtrasTable extras={gate.extras} />
          )}
          <p className="text-[8px] font-mono text-gray-700 pt-1 border-t border-[#1a1a1a]">
            Source: {gate.source}
          </p>
        </div>
      )}
    </div>
  );
}

interface SectionProps { label: string; body: string; mono?: boolean; tone?: 'warn' }
function Section({ label, body, mono, tone }: SectionProps) {
  const text =
    tone === 'warn' ? 'text-yellow-300' :
    'text-gray-300';
  return (
    <div className="space-y-0.5">
      <p className="text-[8px] font-black text-gray-600 uppercase tracking-widest">{label}</p>
      <p className={`text-[10px] leading-relaxed ${mono ? 'font-mono' : ''} ${text}`}>{body}</p>
    </div>
  );
}

function ExtrasTable({ extras }: { extras: Record<string, unknown> }) {
  const entries = Object.entries(extras);
  return (
    <div className="space-y-0.5">
      <p className="text-[8px] font-black text-gray-600 uppercase tracking-widest">Internals</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] font-mono">
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-baseline gap-2 truncate">
            <span className="text-gray-700 shrink-0">{k}</span>
            <span className="text-gray-300 truncate" title={String(v)}>{formatExtra(v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatExtra(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    if (Math.abs(v) >= 1000 || (Math.abs(v) < 0.001 && v !== 0)) return v.toExponential(2);
    return v.toFixed(3);
  }
  return String(v);
}
