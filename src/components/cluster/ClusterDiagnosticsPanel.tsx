/**
 * Panel A — Cluster Diagnostics. Self-fetches /api/cluster/diagnostics on mount,
 * renders the universe-stability tile strip + detail block per Phase 2 §5.5
 * SPEC §3.5.
 *
 * Render branches (matches SPEC table):
 *   loading                  → muted skeleton
 *   error                    → red-bordered card with the server `error` message
 *   data, rows.length === 0  → yellow-bordered "no diagnostics yet" card
 *   data, rows.length > 0    → tile strip (one tile per week) + detail block
 */
import { Fragment, useEffect, useState } from 'react';
import type { ClusterDiagnosticsResponse, ClusterDiagnosticsRow } from '../../server/cluster_dashboard.js';

interface State {
  data: ClusterDiagnosticsResponse | null;
  loading: boolean;
  error: string | null;
}

const STATUS_COLOR: Record<ClusterDiagnosticsRow['status'], string> = {
  published:        'bg-emerald-500/[0.06] border-emerald-400/30 text-emerald-300',
  single_cohort:    'bg-emerald-500/[0.06] border-emerald-400/30 text-emerald-300',
  q_below_threshold:'bg-yellow-500/[0.06] border-yellow-400/30 text-yellow-300',
  unstable:         'bg-red-500/[0.06] border-red-400/30 text-red-300',
  degenerate:       'bg-red-500/[0.06] border-red-400/30 text-red-300',
  untradeable:      'bg-red-500/[0.06] border-red-400/30 text-red-300',
  informational:    'bg-zinc-500/[0.06] border-zinc-400/30 text-zinc-300',
};

/**
 * Status → reason-sentence map per SPEC §3.5.1. Each branch is canon-grounded
 * (cluster_tokens_weekly.py's gate cascade documents the same logic). Keep the
 * sentences honest — these are the diagnostic's own words to the user, not
 * marketing copy.
 */
function reasonSentence(r: ClusterDiagnosticsRow): string {
  switch (r.status) {
    case 'published':
      return `${r.nClustersHdb} clusters published; q=${r.qScore?.toFixed(2) ?? '—'}; both methods agree within ${r.nDisagreement} cluster.`;
    case 'single_cohort':
      return `1 tradeable cohort + ${Math.max(0, r.nClustersHdb - 1)} hard-excluded; disagreement-gate bypassed per ADR-014.`;
    case 'q_below_threshold':
      return `q-score ${r.qScore?.toFixed(2) ?? '—'} < 0.50 — partition not stable across bootstraps; membership not updated.`;
    case 'unstable':
      return `Δk = ${r.nDisagreement} > 1 — HDBSCAN and GMM disagree; membership not updated.`;
    case 'degenerate':
      return `HDBSCAN found 0 non-noise clusters — feature space degenerate.`;
    case 'untradeable':
      return `All clusters below tradeability vol (≥ 0.10 ann); nothing to publish for trading.`;
    case 'informational':
      return `Diagnostic-only row.`;
  }
}

export default function ClusterDiagnosticsPanel() {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/cluster/diagnostics?weeks=12&method=hdbscan')
      .then(async r => {
        if (!r.ok) {
          const detail = await r.text().catch(() => '');
          throw new Error(`${r.status} ${r.statusText}${detail ? ` — ${detail.slice(0, 240)}` : ''}`);
        }
        return r.json() as Promise<ClusterDiagnosticsResponse>;
      })
      .then(data => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch(err => {
        if (!cancelled) setState({ data: null, loading: false, error: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, []);

  if (state.loading) {
    return (
      <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-2xl p-6">
        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-cyan-400/70 mb-4">Cluster Diagnostics</h3>
        <div className="flex gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="w-20 h-24 bg-zinc-800/40 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="bg-[#0a0a0a] border border-red-500/40 rounded-2xl p-6">
        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-red-400 mb-2">Cluster Diagnostics</h3>
        <p className="text-[11px] font-mono text-red-300">Cluster diagnostics unavailable — {state.error}</p>
      </div>
    );
  }

  const data = state.data!;
  if (data.rows.length === 0) {
    return (
      <div className="bg-[#0a0a0a] border border-yellow-500/30 rounded-2xl p-6">
        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-yellow-400 mb-2">Cluster Diagnostics</h3>
        <p className="text-[11px] font-mono text-yellow-200/80">
          No HDBSCAN diagnostics in the last {data.weeks} weeks. Run <code className="text-cyan-300">npm run cluster:weekly</code>.
        </p>
      </div>
    );
  }

  const latest = data.rows[data.rows.length - 1];
  const cohort = latest.cohortComposition;

  return (
    <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-2xl p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-cyan-400/70">Cluster Diagnostics</h3>
        <span className="text-[9px] font-mono text-zinc-500">last {data.weeks} weeks · method: {data.method}</span>
      </div>

      {/* Tile strip */}
      <div className="flex gap-2 overflow-x-auto pb-2 mb-4">
        {data.rows.map((r, i) => (
          // Fragment-wrap the keyed custom component — project tsconfig has no
          // @types/react, so JSX.IntrinsicAttributes doesn't inject `key` on
          // user components. Existing pattern: GateDetailPanel.tsx:50.
          <Fragment key={`${r.weekStart}-${r.fitId}`}>
            <DiagnosticsTile row={r} thresholds={data.thresholds} isLatest={i === data.rows.length - 1} />
          </Fragment>
        ))}
      </div>

      {/* Detail block for the latest week */}
      <div className="grid grid-cols-12 gap-4 pt-4 border-t border-[#1a1a1a]">
        <div className="col-span-4">
          <div className={`text-lg font-black uppercase tracking-wide ${STATUS_COLOR[latest.status].split(' ').filter(c => c.startsWith('text-')).join(' ')}`}>
            {latest.status}
          </div>
          <p className="text-[11px] font-mono text-zinc-300 mt-2">{reasonSentence(latest)}</p>
        </div>
        <div className="col-span-3 text-[10px] font-mono space-y-1">
          <DetailNum label="q-score" value={latest.qScore} fmt={n => n.toFixed(2)} bad={n => n < data.thresholds.qScore} />
          <DetailNum label="silhouette" value={latest.silhouette} fmt={n => n.toFixed(2)} />
          <DetailNum label="C–H" value={latest.calinskiHarabasz} fmt={n => n.toFixed(0)} />
          <DetailNum label="Δk" value={latest.nDisagreement} fmt={n => `${n}`} bad={n => n > data.thresholds.disagreement} />
          <DetailNum label="N admitted" value={latest.nAdmitted} fmt={n => `${n}`} bad={n => n === 0} />
        </div>
        <div className="col-span-3">
          {cohort ? (
            <div>
              <div className="text-[9px] font-black uppercase tracking-widest text-zinc-500 mb-1">Cohort tier mix</div>
              <CohortBar breakdown={cohort.breakdown} />
              <p className="text-[10px] font-mono mt-1 text-zinc-300">
                {cohort.dominantTier} <span className="text-zinc-500">·</span> {(cohort.dominantPct * 100).toFixed(0)}%
                {cohort.isFragmented && <span className="ml-2 text-yellow-300">fragmented</span>}
              </p>
            </div>
          ) : (
            <p className="text-[10px] font-mono text-zinc-500">tier mix unavailable</p>
          )}
        </div>
        <div className="col-span-2 text-[9px] font-mono text-zinc-500 space-y-1">
          <div>fit_id: <span className="text-zinc-300">{latest.fitId.slice(0, 8)}</span></div>
          <div>computed: <span className="text-zinc-300">{latest.computedAt.slice(0, 16)}</span></div>
          <div>fit time: <span className="text-zinc-300">{latest.fitSeconds.toFixed(1)}s</span></div>
          {latest.hasOrphans && (
            <div className="mt-2 inline-block bg-amber-500/10 border border-amber-400/40 rounded px-2 py-1 text-amber-300">
              orphan diagnostic rows present
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface DetailNumProps {
  label: string;
  value: number | null;
  fmt: (n: number) => string;
  bad?: (n: number) => boolean;
}

function DetailNum({ label, value, fmt, bad }: DetailNumProps) {
  const isBad = value !== null && bad?.(value) === true;
  return (
    <div className="flex justify-between gap-2">
      <span className="text-zinc-500">{label}</span>
      <span className={isBad ? 'text-red-300' : 'text-zinc-200'}>
        {value === null ? '—' : fmt(value)}
      </span>
    </div>
  );
}

interface DiagnosticsTileProps {
  row: ClusterDiagnosticsRow;
  thresholds: ClusterDiagnosticsResponse['thresholds'];
  isLatest: boolean;
}

function DiagnosticsTile({ row, thresholds, isLatest }: DiagnosticsTileProps) {
  const cls = STATUS_COLOR[row.status];
  const qBad = row.qScore !== null && row.qScore < thresholds.qScore;
  const dkBad = row.nDisagreement > thresholds.disagreement;
  return (
    <div
      className={`relative w-20 flex-shrink-0 border rounded-lg px-2 py-2 ${cls} ${isLatest ? 'ring-1 ring-cyan-400/50' : ''}`}
      title={`${row.weekStart} · ${row.status} · fit ${row.fitId.slice(0, 8)}`}
    >
      {row.hasOrphans && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-400" />}
      <div className="text-[8px] font-black uppercase tracking-widest text-zinc-500">{row.weekStart.slice(5)}</div>
      <div className="text-[10px] font-mono mt-1">
        k={row.nClustersHdb}/<span className={dkBad ? 'text-red-300' : ''}>{row.nClustersGmm ?? '—'}</span>
      </div>
      <div className={`text-[9px] font-mono ${qBad ? 'text-red-300' : ''}`}>
        q={row.qScore !== null ? row.qScore.toFixed(2) : '—'}
      </div>
      <div className={`text-[9px] font-mono ${row.nAdmitted === 0 ? 'text-yellow-300' : ''}`}>
        N={row.nAdmitted}
      </div>
      <div className="text-[7px] font-black uppercase tracking-widest mt-1 truncate">
        {row.status.replace('_', ' ')}
      </div>
    </div>
  );
}

interface CohortBarProps {
  breakdown: { tier: string; pct: number }[];
}

const TIER_BAR_COLORS = ['bg-cyan-500/60', 'bg-emerald-500/60', 'bg-yellow-500/60', 'bg-rose-500/60', 'bg-violet-500/60'];

function CohortBar({ breakdown }: CohortBarProps) {
  return (
    <div className="flex h-3 w-full rounded overflow-hidden bg-zinc-800/40">
      {breakdown.map((b, i) => (
        <div
          key={b.tier}
          className={TIER_BAR_COLORS[i % TIER_BAR_COLORS.length]}
          style={{ width: `${(b.pct * 100).toFixed(2)}%` }}
          title={`${b.tier}: ${(b.pct * 100).toFixed(0)}%`}
        />
      ))}
    </div>
  );
}
