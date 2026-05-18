/**
 * Panel B — Cluster-axis four-gate scores. Self-fetches /api/cluster/scores on
 * mount, renders the row table per Phase 2 §5.5 SPEC §3.6.
 *
 * Render branches:
 *   loading                        → skeleton
 *   error 404 no_published_fit     → yellow "run cluster:weekly first"
 *   error other                    → red-bordered card
 *   data, rows.length === 0        → yellow "fit has no scored cells"
 *   data, rows.length > 0          → header + summary chip + row table
 *
 * Each row shows:
 *   - strategy, cluster_id, interval, best_param
 *   - composite + four-gate pills (DSR / PBO / HLZ / OOS-IS)
 *   - tier-axis comparator chip (when cohort not fragmented + comparator exists)
 *   - deflationCollapseHint inline when present (psr ≥ 0.95 && dsr ≤ 0.05)
 *   - row click → /#/validator?axis=cluster&strategy=...&clusterId=...&interval=...
 */
import { Fragment, useEffect, useState } from 'react';
import type { ClusterScoresResponse, ClusterScoreRow } from '../../server/cluster_dashboard.js';

// Gate thresholds for pill display. Match score_strategies.ts / score_strategies_by_cluster.ts.
const GATE = { dsr: 0.95, pbo: 0.5, oosIs: 0.3 } as const;

interface State {
  data: ClusterScoresResponse | null;
  loading: boolean;
  error: { kind: 'no_fit' | 'other'; message: string } | null;
}

export default function ClusterScoresPanel() {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/cluster/scores')
      .then(async r => {
        if (r.status === 404) {
          const body = await r.json().catch(() => null) as { error?: string; detail?: string } | null;
          throw { kind: 'no_fit' as const, message: body?.detail ?? 'No published fit' };
        }
        if (!r.ok) {
          const detail = await r.text().catch(() => '');
          throw { kind: 'other' as const, message: `${r.status} ${r.statusText}${detail ? ` — ${detail.slice(0, 240)}` : ''}` };
        }
        return r.json() as Promise<ClusterScoresResponse>;
      })
      .then(data => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch(err => {
        if (cancelled) return;
        if (err && typeof err === 'object' && 'kind' in err && (err.kind === 'no_fit' || err.kind === 'other')) {
          setState({ data: null, loading: false, error: err as State['error'] });
        } else {
          setState({ data: null, loading: false, error: { kind: 'other', message: String(err instanceof Error ? err.message : err) } });
        }
      });
    return () => { cancelled = true; };
  }, []);

  if (state.loading) {
    return (
      <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-2xl p-6">
        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-cyan-400/70 mb-4">Cluster Scores</h3>
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 bg-zinc-800/40 rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (state.error?.kind === 'no_fit') {
    return (
      <div className="bg-[#0a0a0a] border border-yellow-500/30 rounded-2xl p-6">
        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-yellow-400 mb-2">Cluster Scores</h3>
        <p className="text-[11px] font-mono text-yellow-200/80">
          No published HDBSCAN fit yet. Run <code className="text-cyan-300">npm run cluster:weekly</code> for a recent week.
        </p>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="bg-[#0a0a0a] border border-red-500/40 rounded-2xl p-6">
        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-red-400 mb-2">Cluster Scores</h3>
        <p className="text-[11px] font-mono text-red-300">Cluster scores unavailable — {state.error.message}</p>
      </div>
    );
  }

  const data = state.data!;
  if (data.rows.length === 0) {
    return (
      <div className="bg-[#0a0a0a] border border-yellow-500/30 rounded-2xl p-6">
        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-yellow-400 mb-2">Cluster Scores</h3>
        <p className="text-[11px] font-mono text-yellow-200/80">
          Fit <code className="text-cyan-300">{data.fitId.slice(0, 8)}</code> has no scored cells. Run{' '}
          <code className="text-cyan-300">npm run score:by-cluster</code>.
        </p>
      </div>
    );
  }

  const passing = data.rows.filter(r => r.gatesPass).length;
  const headlineEmerald = passing > 0;

  return (
    <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-2xl p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-cyan-400/70">Cluster Scores</h3>
        <span className="text-[9px] font-mono text-zinc-500">
          fit <span className="text-zinc-300">{data.fitId.slice(0, 8)}</span> · week {data.weekStart} · status {data.status}
          {data.cohort && ` · ${data.cohort.nAdmitted} admitted`}
          {data.isStale && (
            <span className="ml-2 inline-block bg-amber-500/10 border border-amber-400/40 rounded px-1.5 py-0.5 text-amber-300">
              fit is {data.fitAgeDays} days old
            </span>
          )}
        </span>
      </div>

      {/* Fallback banner — fired when default-resolution chose a SCORED fit
          older than the latest published fit. Honest signal that scoring lags
          publication; not a bug, just operational reality between weekly
          cluster_tokens_weekly runs and ad-hoc batch_backtest invocations. */}
      {data.fallbackInfo && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-amber-400/30 bg-amber-500/[0.06]">
          <div className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-300 mb-1">
            Showing latest scored fit ({data.fallbackInfo.weeksBehind}wk behind published)
          </div>
          <p className="text-[10px] font-mono text-amber-200/80 leading-relaxed">
            Latest published fit{' '}
            <code className="text-amber-100">{data.fallbackInfo.latestPublishedFitId.slice(0, 8)}</code>
            {' '}(week {data.fallbackInfo.latestPublishedWeekStart}) has no scored cells yet.
            This view shows fit{' '}
            <code className="text-amber-100">{data.fitId.slice(0, 8)}</code> from week {data.weekStart}.
            To refresh: re-run{' '}
            <code className="text-cyan-300">npm run score:by-cluster</code>{' '}
            after the next{' '}
            <code className="text-cyan-300">batch_backtest.ts</code>{' '}
            run tags new bt_runs with the current fit_id.
          </p>
        </div>
      )}

      {/* Headline summary chip — honest about today's 0/4 result */}
      <div className="mb-4">
        <span className={`text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-lg border ${
          headlineEmerald
            ? 'bg-emerald-500/10 border-emerald-400/40 text-emerald-300'
            : 'bg-red-500/10 border-red-400/40 text-red-300'
        }`}>
          {headlineEmerald
            ? `${passing} of ${data.rows.length} cells clear all four gates`
            : `${data.rows.length} of ${data.rows.length} cells fail at least one gate · system working as designed`
          }
        </span>
      </div>

      {/* Row table */}
      <div className="space-y-2">
        {data.rows.map((row) => (
          // Fragment-wrap for `key` (project tsconfig has no @types/react;
          // mirrors GateDetailPanel.tsx:50 pattern).
          <Fragment key={`${row.strategyType}|${row.clusterId}|${row.interval}|${row.bestParam}`}>
            <ClusterRow row={row} />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function ClusterRow({ row }: { row: ClusterScoreRow }) {
  function onClick() {
    const params = new URLSearchParams({
      axis: 'cluster',
      strategy: row.strategyType,
      clusterId: String(row.clusterId),
      interval: row.interval,
    });
    window.location.hash = `/validator?${params.toString()}`;
  }

  // Pill states. `null` (n/a) is distinct from fail — render gray.
  const dsrPass = row.dsr >= GATE.dsr;
  const pboPass = row.pbo !== null && row.pbo < GATE.pbo;
  const hlzPass = row.hlzTPasses;
  const oosPass = row.oosIsRatio >= GATE.oosIs;

  const cmp = row.tierAxisCompare;
  const cmpEmerald = cmp !== null && cmp.deltaDsr > 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      className="border border-[#1a1a1a] rounded-lg p-3 hover:border-cyan-400/40 cursor-pointer transition-colors"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-[11px] font-black text-white truncate">{row.strategyType}</span>
          <span className="text-[9px] font-mono text-zinc-500">cluster {row.clusterId}</span>
          <span className="text-[9px] font-mono text-zinc-500">{row.interval}</span>
          <span className="text-[9px] font-mono text-zinc-500">p={row.bestParam}</span>
          <span className="text-[9px] font-mono text-zinc-300">comp={row.composite.toFixed(3)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Pill label="DSR" value={row.dsr.toFixed(2)} status={dsrPass ? 'pass' : 'fail'} />
          <Pill label="PBO" value={row.pbo === null ? '—' : row.pbo.toFixed(2)} status={row.pbo === null ? 'na' : (pboPass ? 'pass' : 'fail')} />
          <Pill label="HLZ" value={hlzPass ? '✓' : '·'} status={hlzPass ? 'pass' : 'fail'} />
          <Pill label="OOS/IS" value={row.oosIsRatio.toFixed(2)} status={oosPass ? 'pass' : 'fail'} />
        </div>
      </div>
      <div className="flex items-center gap-3 mt-2 flex-wrap">
        <span className="text-[9px] font-mono text-zinc-500">
          IS=<span className="text-zinc-300">{row.wtNetPct.toFixed(1)}%</span>
          {' · '}
          OOS=<span className="text-zinc-300">{row.oosWtNetPct.toFixed(1)}%</span>
          {' · '}
          trades=<span className="text-zinc-300">{row.totalTrades.toLocaleString()}</span>
          {' · '}
          tokens=<span className="text-zinc-300">{row.nTokensTraded}/{row.nTokensTotal}</span>
        </span>
        {cmp && (
          <span
            className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border ${
              cmpEmerald
                ? 'bg-emerald-500/10 border-emerald-400/40 text-emerald-300'
                : 'bg-red-500/10 border-red-400/40 text-red-300'
            }`}
            title={`tier-axis ${cmp.tier}: composite=${cmp.composite.toFixed(3)} dsr=${cmp.dsr.toFixed(2)}`}
          >
            vs tier ({cmp.tier}): DSR Δ {cmp.deltaDsr >= 0 ? '+' : ''}{cmp.deltaDsr.toFixed(2)}
          </span>
        )}
      </div>
      {row.deflationCollapseHint && (
        <p className="text-[10px] font-mono italic text-zinc-400 mt-2">{row.deflationCollapseHint}</p>
      )}
    </div>
  );
}

interface PillProps { label: string; value: string; status: 'pass' | 'fail' | 'na' }

function Pill({ label, value, status }: PillProps) {
  const cls =
    status === 'pass' ? 'bg-emerald-500/10 border-emerald-400/40 text-emerald-300'
    : status === 'fail' ? 'bg-red-500/10 border-red-400/40 text-red-300'
    : 'bg-zinc-500/10 border-zinc-400/40 text-zinc-400';
  return (
    <span className={`inline-flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider border rounded px-1.5 py-0.5 ${cls}`}>
      <span className="font-black">{label}</span>
      <span>{value}</span>
    </span>
  );
}
