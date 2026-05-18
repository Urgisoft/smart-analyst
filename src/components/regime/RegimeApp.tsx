/**
 * Macro-regime dashboard route — Track C / Component 3.
 *
 * Mounted by main.tsx when location.hash matches "#/regime". Surfaces the
 * macro regime classifier's current state (under classifier_version=
 * phase1_v2) with the ADR-037 bias-quarantine banner first-class, the
 * indicator strip with raw values, the 5d rolling-union grid, the 252d
 * timeline, and the distribution-vs-baseline table.
 *
 * Self-fetches /api/regime/state on mount + via the refresh button. All
 * five panels read from one response so the bias banner can never desync
 * from the regime label.
 *
 * SPEC: docs/specs/regime-dashboard-component3.md.
 */
import { useCallback, useEffect, useState } from 'react';
import type { RegimeStateResponse } from '../../server/regime_dashboard.js';
import { BiasBanner } from './panels/BiasBanner.js';
import { TodayPanel } from './panels/TodayPanel.js';
import { TimelineHeatmap } from './panels/TimelineHeatmap.js';
import { FiveDayGrid } from './panels/FiveDayGrid.js';
import { DistributionTable } from './panels/DistributionTable.js';

interface State {
  data: RegimeStateResponse | null;
  loading: boolean;
  error: string | null;
}

export default function RegimeApp() {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });

  const refresh = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const r = await fetch('/api/regime/state');
      if (!r.ok) {
        let detail = `HTTP ${r.status}`;
        try {
          const body = await r.json();
          if (body && typeof body === 'object' && 'detail' in body) {
            detail = `${body.error}: ${body.detail}`;
          }
        } catch { /* fall through to status-only */ }
        throw new Error(detail);
      }
      const data = await r.json() as RegimeStateResponse;
      setState({ data, loading: false, error: null });
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <header className="h-16 border-b border-[#1a1a1a] flex items-center justify-between px-8 bg-black sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-[0_0_10px_rgba(251,191,36,0.5)]" />
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-white italic">
            VECTOR_REGIME · Macro Classifier
          </h2>
          {state.data && (
            <span className="text-[10px] font-mono text-zinc-500 ml-2">
              {state.data.classifierVersion} · {state.data.timeline.length} days loaded
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/"
            className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500 hover:text-white transition-colors"
          >
            ← back
          </a>
          <button
            onClick={refresh}
            disabled={state.loading}
            className="text-[10px] font-mono uppercase tracking-[0.2em] text-cyan-300 hover:text-cyan-100 border border-cyan-400/30 hover:border-cyan-400/60 rounded px-3 py-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {state.loading ? 'loading…' : 'refresh'}
          </button>
        </div>
      </header>

      <main className="p-6 max-w-[1600px] mx-auto">
        {state.error && (
          <div className="border border-red-500/40 bg-red-500/10 rounded p-4 mb-4">
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-red-300 mb-1">
              Failed to load regime state
            </div>
            <div className="text-[11px] font-mono text-red-200/80">{state.error}</div>
            <div className="text-[10px] font-mono text-zinc-500 mt-2">
              If <code className="text-zinc-300">no_regime_rows</code>, run{' '}
              <code className="text-cyan-300">npm run macro:backfill</code> first.
            </div>
          </div>
        )}

        {state.loading && !state.data && (
          <div className="text-[11px] font-mono text-zinc-500">loading regime state…</div>
        )}

        {state.data && (
          <>
            <BiasBanner note={state.data.biasNote} classifierVersion={state.data.classifierVersion} />
            <div className="border border-amber-500/30 bg-amber-500/5 rounded p-3 mb-4 flex items-start gap-3">
              <div className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-300 whitespace-nowrap pt-0.5">
                Phase 9 reminder
              </div>
              <div className="text-[11px] font-mono text-amber-100/80 leading-relaxed">
                Future regime classifier extensions — margin debt growth, aggregate short interest ΔROC,
                CFTC COT positioning, ETF flow divergence — are documented as candidates only.
                Build is <span className="text-amber-300 font-bold">not authorized</span> until paper-trading
                shakedown and phase1_v3 validation close.
                See <code className="text-cyan-300">docs/specs/regime-classifier-phase9-candidates.md</code>.
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4">
              <TodayPanel
                today={state.data.today}
                daysInCurrentRegime={state.data.daysInCurrentRegime}
                previousRegime={state.data.previousRegime}
                asOfDate={state.data.asOfDate}
                isLatest={state.data.isLatest}
              />
              <FiveDayGrid window={state.data.fiveDayWindow} />
              <TimelineHeatmap rows={state.data.timeline} />
              <DistributionTable distribution={state.data.distribution} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
