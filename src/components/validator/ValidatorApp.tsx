/**
 * Validator route — top-level container for the four-gate validator UI.
 *
 * Layout: 12-column grid mirroring the main dashboard's density. Input on the left
 * (cols 1-5), Verdict + per-gate on the right (cols 6-12). Single full-height view.
 *
 * Mounted by main.tsx when location.hash matches "#/validator". The main App.tsx is
 * untouched — Path 2 lives in its own route to avoid wedging 400 lines of TSX into
 * the existing 2300-line dashboard.
 */

import { useState } from 'react';
import { InputPanel, type ScoreDispatch } from './InputPanel';
import { VerdictPanel } from './VerdictPanel';
import { GateDetailPanel } from './GateDetailPanel';
import type { ValidatorResult } from '../../lib/validator';
import { readHashParams } from '../../lib/validator_hash_params';

export default function ValidatorApp() {
  const [result, setResult] = useState<ValidatorResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Read URL hash params ONCE on mount (not on hashchange) — `initialSweepState`
  // is the form's startup value; live re-hydration would clobber whatever the
  // user typed. PUSHBACK-aligned per Phase 2 §5.5 §3.7: no auto-submit, no
  // silent overwrites.
  const [initialSweepState] = useState(() => readHashParams(window.location.hash));

  async function handleScore(dispatch: ScoreDispatch) {
    setBusy(true);
    setErrorMessage(null);
    // Cluster-axis dispatches go to the same /score-cell endpoint with
    // ?axis=cluster — server-side route picks the right parser per axis.
    const url = dispatch.kind === 'csv'
      ? '/api/validator/score'
      : `/api/validator/score-cell?axis=${dispatch.axis}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dispatch.request),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        let parsed: { error?: string; detail?: string } | null = null;
        try { parsed = JSON.parse(detail); } catch { /* keep raw */ }
        setErrorMessage(
          parsed?.detail
            ? `${parsed.error ?? 'error'}: ${parsed.detail}`
            : `${resp.status} ${resp.statusText}${detail ? ` — ${detail.slice(0, 240)}` : ''}`
        );
        setResult(null);
        return;
      }
      const json = await resp.json() as ValidatorResult;
      setResult(json);
    } catch (err) {
      setErrorMessage(`Network error: ${err instanceof Error ? err.message : String(err)}`);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  function handleClear() {
    setResult(null);
    setErrorMessage(null);
  }

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <header className="h-16 border-b border-[#1a1a1a] flex items-center justify-between px-8 bg-black">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse shadow-[0_0_10px_rgba(250,204,21,0.5)]" />
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-white italic">
            VECTOR_VALIDATOR · Four-Gate Defensive Stack
          </h2>
        </div>
        <div className="flex items-center gap-4">
          <a
            href="#/paper-trading"
            className="text-[10px] font-black text-emerald-400/80 hover:text-emerald-300 uppercase tracking-[0.2em] border border-emerald-400/30 hover:border-emerald-400 rounded-lg px-3 py-1.5 transition-colors"
          >
            Paper trading →
          </a>
          <a
            href="#/"
            className="text-[10px] font-black text-yellow-400/80 hover:text-yellow-300 uppercase tracking-[0.2em] border border-yellow-400/30 hover:border-yellow-400 rounded-lg px-3 py-1.5 transition-colors"
          >
            ← Terminal
          </a>
        </div>
      </header>

      <main className="p-6">
        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-12 xl:col-span-5">
            <InputPanel
              onScore={handleScore}
              onClear={handleClear}
              busy={busy}
              initialSweepState={initialSweepState}
            />
            <p className="text-[9px] font-mono text-gray-700 mt-3 leading-relaxed px-1">
              <span className="text-yellow-400/70">DSR</span> (AFML §11.4) ·{' '}
              <span className="text-yellow-400/70">PBO</span> (BBLPZ 2014 §2 · CSCV) ·{' '}
              <span className="text-yellow-400/70">HLZ-BHY</span> (HLZ 2016 §3-4 · one-sided) ·{' '}
              <span className="text-yellow-400/70">OOS/IS</span> (Pardo 2008 §10 · Sharpe ratio).
              <br />
              N/A ≠ fail. A gate that can't run is reported with the missing input, not as a failure.
            </p>
          </div>
          <div className="col-span-12 xl:col-span-7 space-y-4">
            <VerdictPanel result={result} errorMessage={errorMessage} />
            <GateDetailPanel result={result} />
          </div>
        </div>
      </main>
    </div>
  );
}
