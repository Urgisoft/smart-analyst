/**
 * Market cycle-position dashboard — Phase A6.
 *
 * Mounted by main.tsx when location.hash matches "#/cycle-position". Surfaces
 * the latest `quantlab.cycle_position_snapshots` row plus a trailing history
 * window. SPEC: docs/specs/market-cycle-position.md §3 (component diagram,
 * dashboard panel branch).
 *
 * Self-fetches /api/cycle-position on mount + via the refresh button. The
 * dashboard renders a friendly "awaiting first daemon cycle" panel when
 * `hasData=false` (table missing or empty) rather than a hard error, mirror-
 * ing the morning-brief renderer's graceful-degrade posture.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  CyclePositionStateResponse,
  CyclePositionLatestPayload,
} from '../../server/cycle_position_dashboard.js';
import { LatestPanel } from './panels/LatestPanel.js';
import { ContributionsPanel } from './panels/ContributionsPanel.js';
import { ScoreTrendPanel } from './panels/ScoreTrendPanel.js';
import { InputsTablePanel } from './panels/InputsTablePanel.js';

interface State {
  data: CyclePositionStateResponse | null;
  loading: boolean;
  error: string | null;
  lookbackDays: number;
}

const LOOKBACK_OPTIONS: number[] = [90, 365, 730, 1825];
const DEFAULT_LOOKBACK = 365;

export default function CyclePositionApp() {
  const [state, setState] = useState<State>({
    data: null,
    loading: true,
    error: null,
    lookbackDays: DEFAULT_LOOKBACK,
  });

  const refresh = useCallback(async (lookbackDays: number) => {
    setState(s => ({ ...s, loading: true, error: null, lookbackDays }));
    try {
      const r = await fetch(`/api/cycle-position?lookbackDays=${lookbackDays}`);
      if (!r.ok) {
        let detail = `HTTP ${r.status}`;
        try {
          const body = await r.json();
          if (body && typeof body === 'object' && 'detail' in body) {
            detail = `${body.error}: ${body.detail}`;
          }
        } catch { /* fall through */ }
        throw new Error(detail);
      }
      const data = await r.json() as CyclePositionStateResponse;
      setState({ data, loading: false, error: null, lookbackDays });
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  useEffect(() => { refresh(DEFAULT_LOOKBACK); }, [refresh]);

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <header className="h-16 border-b border-[#1a1a1a] flex items-center justify-between px-8 bg-black sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_10px_rgba(34,211,238,0.5)]" />
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-white italic">
            VECTOR_CYCLE · Market Cycle Position
          </h2>
          {state.data?.hasData && state.data.latest && (
            <span className="text-[10px] font-mono text-zinc-500 ml-2">
              {state.data.latest.compositeVersion} ·{' '}
              {state.data.history.length} days loaded
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 text-[10px] font-mono">
            <span className="text-zinc-500 uppercase tracking-[0.15em]">window</span>
            {LOOKBACK_OPTIONS.map(opt => (
              <button
                key={opt}
                onClick={() => refresh(opt)}
                disabled={state.loading}
                className={`px-2 py-0.5 rounded border transition-colors ${
                  state.lookbackDays === opt
                    ? 'border-cyan-400/60 text-cyan-200 bg-cyan-400/10'
                    : 'border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {opt}d
              </button>
            ))}
          </div>
          <a
            href="/"
            className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500 hover:text-white transition-colors"
          >
            ← back
          </a>
          <button
            onClick={() => refresh(state.lookbackDays)}
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
              Failed to load cycle-position state
            </div>
            <div className="text-[11px] font-mono text-red-200/80">{state.error}</div>
          </div>
        )}

        {state.loading && !state.data && (
          <div className="text-[11px] font-mono text-zinc-500">loading cycle-position…</div>
        )}

        {state.data && !state.data.hasData && (
          <EmptyState />
        )}

        {state.data && state.data.hasData && state.data.latest && (
          <CycleDashboardLayout
            latest={state.data.latest}
            history={state.data.history}
          />
        )}
      </main>
    </div>
  );
}

function CycleDashboardLayout({
  latest,
  history,
}: {
  latest: CyclePositionLatestPayload;
  history: CyclePositionStateResponse['history'];
}) {
  return (
    <>
      <SpecBanner />
      <div className="grid grid-cols-1 gap-4">
        <LatestPanel latest={latest} historyLen={history.length} />
        <ContributionsPanel latest={latest} />
        <ScoreTrendPanel history={history} latestScore={latest.score} />
        <InputsTablePanel latest={latest} history={history} />
      </div>
    </>
  );
}

function SpecBanner() {
  return (
    <div className="border border-cyan-500/30 bg-cyan-500/5 rounded p-3 mb-4 flex items-start gap-3">
      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-300 whitespace-nowrap pt-0.5">
        Informational · v1
      </div>
      <div className="text-[11px] font-mono text-cyan-100/80 leading-relaxed">
        The cycle-position composite is <span className="text-cyan-300 font-bold">informational only</span>{' '}
        in v1 (Option A). It does NOT fire a regime category in `phase1_v3`. Promotion to a direct
        classifier input (Option B) gates on the Phase B backtest + independence-test verdict against
        NBER recession dates. SPEC: <code className="text-cyan-300">docs/specs/market-cycle-position.md</code>.
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="border border-amber-500/30 bg-amber-500/5 rounded p-6">
      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-300 mb-2">
        Awaiting first daemon cycle
      </div>
      <div className="text-[11px] font-mono text-amber-100/80 leading-relaxed">
        <code className="text-amber-200">quantlab.cycle_position_snapshots</code> is empty (or absent).
        To populate, run:
      </div>
      <pre className="mt-3 text-[10px] font-mono text-amber-200 bg-black/40 border border-amber-500/20 rounded p-3 leading-snug">
{`# 1. Ensure schema exists (idempotent dry-run + apply):
npm run migrate:create-cycle-position-snapshots
npm run migrate:create-cycle-position-snapshots:apply

# 2. Run the daemon once to write the first snapshot:
npm run daemon:daily`}
      </pre>
      <div className="text-[10px] font-mono text-zinc-500 mt-3">
        SPEC: <code className="text-cyan-300">docs/specs/market-cycle-position.md §3</code> ·
        composite is invoked post-macro-regime-classify step.
      </div>
    </div>
  );
}
