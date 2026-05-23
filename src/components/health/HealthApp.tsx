/**
 * System health dashboard — ADR-044 Phase 1 read-only surface (s96 #12).
 *
 * Mounted by main.tsx when location.hash matches "#/health". The standing
 * system-health surface required by ADR-044 + the reconciliation audit
 * (docs/audits/system-reconciliation-2026-05.md).
 *
 * What it shows:
 *   1. Summary banner — fresh/stale/missing/pending counts at a glance.
 *   2. Freshness panel — every load-bearing source, sorted worst-first.
 *      Distinguishes autonomous (daemon-refreshed) from operator-cadence
 *      sources so the operator can see at a glance which silent-stale
 *      gaps exist (the reconciliation §3.1 finding).
 *   3. Migration queue panel — operator-pending migrations with their
 *      apply command.
 *
 * Phase-2 panels (not in this slice): quarantine queue (Tier-2 anomalies
 * + operator review actions), auto-fix log (Tier-1 fixes applied since
 * last check), Telegram alert wiring status.
 *
 * Self-fetches /api/health/state on mount + via the refresh button.
 * Always renders something — the underlying handler degrades CH failures
 * to per-source `missing-table` rows rather than HTTP errors, so the
 * panel never sees a true outage state (it sees data with everything
 * marked missing).
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  HealthCheckResponse,
  HealthSourceProbe,
  HealthMigrationProbe,
  HealthStatus,
  HealthCadence,
  QuarantineRow,
  QuarantineSummary,
  QuarantineStatus,
} from '../../server/health_dashboard.js';

interface State {
  data: HealthCheckResponse | null;
  loading: boolean;
  error: string | null;
}

export default function HealthApp() {
  const [state, setState] = useState<State>({
    data: null,
    loading: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const r = await fetch('/api/health/state');
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
      const data = await r.json() as HealthCheckResponse;
      setState({ data, loading: false, error: null });
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const allGreen = state.data?.summary.allGreen ?? false;
  const headerDotClass = allGreen
    ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]'
    : 'bg-amber-400 shadow-[0_0_10px_rgba(250,204,21,0.5)]';

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <header className="h-16 border-b border-[#1a1a1a] flex items-center justify-between px-8 bg-black sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full animate-pulse ${headerDotClass}`} />
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-white italic">
            VECTOR_HEALTH · Standing System-Health Monitor
          </h2>
          {state.data && (
            <span className="text-[10px] font-mono text-zinc-500 ml-2">
              ADR-044 · phase 1 · generated {formatRelative(state.data.generatedAt)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/"
            className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500 hover:text-white transition-colors"
          >
            ← back
          </a>
          <button
            onClick={refresh}
            disabled={state.loading}
            className="text-[10px] font-mono uppercase tracking-[0.2em] text-emerald-300 hover:text-emerald-100 border border-emerald-400/30 hover:border-emerald-400/60 rounded px-3 py-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {state.loading ? 'checking…' : 'refresh'}
          </button>
        </div>
      </header>

      <main className="p-6 max-w-[1600px] mx-auto">
        {state.error && (
          <div className="border border-red-500/40 bg-red-500/10 rounded p-4 mb-4">
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-red-300 mb-1">
              Failed to load health state
            </div>
            <div className="text-[11px] font-mono text-red-200/80">{state.error}</div>
          </div>
        )}

        {state.loading && !state.data && (
          <div className="text-[11px] font-mono text-zinc-500">checking system health…</div>
        )}

        {state.data && (
          <div className="flex flex-col gap-6">
            <SpecBanner />
            <SummaryBanner data={state.data} />
            <QuarantinePanel data={state.data.quarantine} />
            <AutoFixLogPanel data={state.data.quarantine} />
            <FreshnessPanel sources={state.data.sources} />
            <MigrationsPanel migrations={state.data.migrations} />
            <Phase3Footer />
          </div>
        )}
      </main>
    </div>
  );
}

function SpecBanner() {
  return (
    <div className="border border-emerald-500/30 bg-emerald-500/5 rounded p-3 flex items-start gap-3">
      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-300 whitespace-nowrap pt-0.5">
        ADR-044 · phase 2 v1
      </div>
      <div className="text-[11px] font-mono text-emerald-100/80 leading-relaxed">
        Standing system-health surface. Phase 1 freshness + migrations PLUS the
        Phase 2 v1 <span className="text-emerald-300 font-bold">quarantine queue</span> + auto-fix log.
        Phase 2 v2 (next cycle) adds plausibility-band probes + per-route HTTP ping;
        Workers B + C ship the brief §0 daily digest, daemon step 0a, and Telegram alerts. SPEC:{' '}
        <code className="text-emerald-300">docs/specs/adr-044-standing-system-health-ownership.md</code>{' '}
        · audit:{' '}
        <code className="text-emerald-300">docs/audits/system-reconciliation-2026-05.md</code>.
      </div>
    </div>
  );
}

function SummaryBanner({ data }: { data: HealthCheckResponse }) {
  const { summary } = data;
  const tiles: Array<{ label: string; value: number; color: string; emphasis: boolean }> = [
    { label: 'Fresh', value: summary.fresh, color: 'text-emerald-300', emphasis: false },
    { label: 'Stale', value: summary.stale, color: 'text-amber-300', emphasis: summary.stale > 0 },
    { label: 'Very stale', value: summary.veryStale, color: 'text-red-300', emphasis: summary.veryStale > 0 },
    { label: 'Missing table', value: summary.missing, color: 'text-red-300', emphasis: summary.missing > 0 },
    { label: 'Never populated', value: summary.neverPopulated, color: 'text-amber-300', emphasis: summary.neverPopulated > 0 },
    { label: 'Pending migrations', value: summary.pendingMigrations, color: 'text-amber-300', emphasis: summary.pendingMigrations > 0 },
    { label: 'Applied migrations', value: summary.appliedMigrations, color: 'text-emerald-300', emphasis: false },
  ];
  return (
    <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">
          Summary
        </div>
        <div className={`text-[10px] font-mono font-bold uppercase tracking-[0.2em] ${summary.allGreen ? 'text-emerald-300' : 'text-amber-300'}`}>
          {summary.allGreen ? 'All systems green' : 'Action required'}
        </div>
      </div>
      <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3">
        {tiles.map(t => (
          <div
            key={t.label}
            className={`border rounded bg-black/40 p-2 ${
              t.emphasis ? 'border-amber-500/40' : 'border-[#1a1a1a]'
            }`}
          >
            <div className="text-[8px] font-mono uppercase tracking-[0.15em] text-zinc-500 mb-1">
              {t.label}
            </div>
            <div className={`text-lg font-mono font-bold ${t.color}`}>
              {t.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FreshnessPanel({ sources }: { sources: ReadonlyArray<HealthSourceProbe> }) {
  // Worst-first sort: stale > missing > never-populated > unknown > fresh.
  // Within tier, autonomous=false sources surface before autonomous=true
  // because they're the operator-actionable items.
  const order: Record<HealthStatus, number> = {
    'missing-table': 0,
    'very-stale': 1,
    'stale': 2,
    'never-populated': 3,
    'unknown-cadence': 4,
    'fresh': 5,
  };
  const sorted = [...sources].sort((a, b) => {
    const oa = order[a.status];
    const ob = order[b.status];
    if (oa !== ob) return oa - ob;
    // Same status — operator-cadence first.
    if (a.autonomous !== b.autonomous) return a.autonomous ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
  return (
    <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">
          Source freshness ({sources.length} sources)
        </div>
        <div className="text-[9px] font-mono text-zinc-500">
          worst-first · operator-cadence before daemon-cadence within tier
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] font-mono">
          <thead>
            <tr className="text-zinc-500 border-b border-[#1a1a1a]">
              <th className="text-left py-1 px-2 uppercase tracking-[0.15em]">Status</th>
              <th className="text-left py-1 px-2 uppercase tracking-[0.15em]">Source</th>
              <th className="text-left py-1 px-2 uppercase tracking-[0.15em]">Cadence</th>
              <th className="text-left py-1 px-2 uppercase tracking-[0.15em]">Refresh</th>
              <th className="text-right py-1 px-2 uppercase tracking-[0.15em]">Rows</th>
              <th className="text-left py-1 px-2 uppercase tracking-[0.15em]">Last update</th>
              <th className="text-left py-1 px-2 uppercase tracking-[0.15em]">Operator action</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(s => (
              <tr
                key={s.name}
                className="border-b border-[#0f0f0f] hover:bg-white/5 align-top"
              >
                <td className="py-1.5 px-2">
                  <StatusBadge status={s.status} />
                </td>
                <td className="py-1.5 px-2">
                  <div className="text-white font-bold">{s.label}</div>
                  <div className="text-[9px] text-zinc-500">
                    quantlab.{s.name}
                  </div>
                </td>
                <td className="py-1.5 px-2 text-zinc-300">
                  <CadenceBadge cadence={s.cadence} />
                </td>
                <td className="py-1.5 px-2">
                  <RefreshBadge autonomous={s.autonomous} />
                </td>
                <td className="py-1.5 px-2 text-right text-zinc-300">
                  {s.rowCount.toLocaleString()}
                </td>
                <td className="py-1.5 px-2 text-zinc-400">
                  {s.lastUpdateAt
                    ? `${formatRelative(s.lastUpdateAt)} (${formatAge(s.lastUpdateAgeHours)})`
                    : '—'}
                </td>
                <td className="py-1.5 px-2">
                  {(s.status !== 'fresh') && (
                    <code className="text-[9px] text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5">
                      {s.operatorAction}
                    </code>
                  )}
                  {s.status === 'fresh' && (
                    <span className="text-[9px] text-zinc-600">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MigrationsPanel({ migrations }: { migrations: ReadonlyArray<HealthMigrationProbe> }) {
  const pending = migrations.filter(m => !m.applied);
  const applied = migrations.filter(m => m.applied);
  return (
    <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4">
      <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-3">
        Migrations · {pending.length} pending · {applied.length} applied
      </div>
      {pending.length === 0 ? (
        <div className="text-[11px] font-mono text-emerald-400/80">
          Every operator-pending migration is applied. CH schema is up to date.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-amber-300 mb-1">
            Pending — operator must apply
          </div>
          {pending.map(m => (
            <div
              key={`${m.applyCommand}-${m.targetTable}`}
              className="border border-amber-500/30 bg-amber-500/5 rounded p-3"
            >
              <div className="flex items-baseline justify-between mb-1">
                <div className="text-[11px] font-mono text-amber-100">{m.label}</div>
                <div className="text-[9px] font-mono text-zinc-500">
                  target: quantlab.{m.targetTable}
                </div>
              </div>
              <code className="text-[10px] font-mono text-amber-200 block bg-black/40 border border-amber-500/20 rounded px-2 py-1 mt-1">
                {m.applyCommand}
              </code>
            </div>
          ))}
        </div>
      )}
      {applied.length > 0 && (
        <details className="mt-4 text-[10px] font-mono text-zinc-500">
          <summary className="cursor-pointer hover:text-zinc-300 uppercase tracking-[0.2em]">
            applied ({applied.length})
          </summary>
          <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-1">
            {applied.map(m => (
              <div
                key={`${m.applyCommand}-${m.targetTable}`}
                className="text-zinc-600 truncate"
                title={`${m.label} → quantlab.${m.targetTable}`}
              >
                ✓ {m.label}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ── Phase 2 v1 panels (Cycle 3 Worker A) ───────────────────────────────────

/**
 * Render the Tier-2 quarantine queue. Three states:
 *   - null   → table not yet migrated; show emerald init banner.
 *   - empty  → table exists but no Tier-2 rows; show empty state.
 *   - rows   → render pending (red), warning (amber), resolved (collapsed).
 *
 * Full `explanation` is shown for pending + warning rows because truncation
 * hides exactly the context operators need at the moment of triage
 * (canon-thin fork resolved per the minimum-free-parameters criterion:
 * truncation requires a length knob; full text requires nothing).
 */
function QuarantinePanel({ data }: { data: QuarantineSummary | null }) {
  if (data === null) {
    return (
      <div className="border border-emerald-500/40 bg-emerald-500/5 rounded-xl p-4">
        <div className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-300 mb-2">
          Quarantine queue · not initialized
        </div>
        <div className="text-[11px] font-mono text-emerald-100/80">
          Phase 2 v1 quarantine table is absent. Run{' '}
          <code className="text-emerald-300">npm run migrate:create-health-quarantine:apply</code>{' '}
          to initialize. The migration ships the Q-5 CBOE pin row (ADR-045){' '}
          on first apply.
        </div>
      </div>
    );
  }

  const pendingRows = data.recentTier2Rows.filter(r => r.status === 'pending');
  const warningRows = data.recentTier2Rows.filter(r => r.status === 'accepted-as-warning');
  const resolvedRows = data.recentTier2Rows.filter(
    r => r.status === 'approved' || r.status === 'corrected',
  );
  const totalPending = data.tier2PendingCount;
  const totalWarning = data.tier2AcceptedAsWarningCount;
  const totalResolved = data.tier2ResolvedCount;
  const isEmpty = totalPending === 0 && totalWarning === 0 && totalResolved === 0;

  return (
    <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">
          Quarantine queue · {totalPending} pending · {totalWarning} warning · {totalResolved} resolved
        </div>
        <div className="text-[9px] font-mono text-zinc-500">
          ADR-044 Phase 2 v1 · Tier-2 rows · pending-first
        </div>
      </div>

      {isEmpty && (
        <div className="text-[11px] font-mono text-emerald-400/80">
          No Tier-2 quarantine rows. Health surface is clean.
        </div>
      )}

      {pendingRows.length > 0 && (
        <div className="flex flex-col gap-2 mb-3">
          <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-red-300 mb-1">
            Pending — operator review required ({totalPending})
          </div>
          {pendingRows.map(row => (
            <div key={row.id}>
              <QuarantineRowCard row={row} tone="red" />
            </div>
          ))}
        </div>
      )}

      {warningRows.length > 0 && (
        <div className="flex flex-col gap-2 mb-3">
          <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-amber-300 mb-1">
            Accepted as warning — informational ({totalWarning})
          </div>
          {warningRows.map(row => (
            <details key={row.id} className="group">
              <summary className="cursor-pointer text-[10px] font-mono text-amber-200/80 hover:text-amber-100 list-none">
                <span className="inline-block mr-2 text-amber-400/60">▶</span>
                <span className="text-amber-100 font-bold">{row.sourceLabel}</span>{' '}
                <span className="text-zinc-500">·</span>{' '}
                {row.category}{' '}
                <span className="text-zinc-500">·</span>{' '}
                {row.adrRef || '(no ADR)'}
              </summary>
              <div className="mt-2">
                <QuarantineRowCard row={row} tone="amber" />
              </div>
            </details>
          ))}
        </div>
      )}

      {totalResolved > 0 && (
        <details className="mt-2 text-[10px] font-mono text-zinc-500">
          <summary className="cursor-pointer hover:text-zinc-300 uppercase tracking-[0.2em]">
            resolved ({totalResolved})
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {resolvedRows.map(row => (
              <div key={row.id}>
                <QuarantineRowCard row={row} tone="zinc" />
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

type QuarantineRowTone = 'red' | 'amber' | 'zinc';

interface QuarantineRowCardProps {
  row: QuarantineRow;
  tone: QuarantineRowTone;
}

function QuarantineRowCard({ row, tone }: QuarantineRowCardProps) {
  const toneClass: Record<QuarantineRowTone, string> = {
    red: 'border-red-500/40 bg-red-500/5',
    amber: 'border-amber-500/40 bg-amber-500/5',
    zinc: 'border-zinc-500/40 bg-zinc-500/5 opacity-80',
  };
  const labelClass: Record<QuarantineRowTone, string> = {
    red: 'text-red-100',
    amber: 'text-amber-100',
    zinc: 'text-zinc-300',
  };
  const dimClass: Record<QuarantineRowTone, string> = {
    red: 'text-red-200/70',
    amber: 'text-amber-200/70',
    zinc: 'text-zinc-400',
  };
  return (
    <div className={`border ${toneClass[tone]} rounded p-3`}>
      <div className="flex items-baseline justify-between mb-1 gap-3 flex-wrap">
        <div className={`text-[11px] font-mono ${labelClass[tone]} font-bold`}>
          {row.sourceLabel}{' '}
          <span className="text-zinc-500 font-normal">·</span>{' '}
          <span className="font-normal">{row.category}</span>
        </div>
        <div className={`text-[9px] font-mono ${dimClass[tone]} flex gap-2 items-center`}>
          <StatusPill status={row.status} />
          <span>severity={row.severity}</span>
          <span>{row.adrRef || 'no-ADR'}</span>
          <span>{row.cycleRef || 'no-cycle'}</span>
        </div>
      </div>
      <div className={`text-[9px] font-mono ${dimClass[tone]} mb-1`}>
        detected {formatRelative(row.detectedAt)} ({row.detectedAt}){' '}
        <span className="text-zinc-500">·</span> source quantlab.{row.sourceTable}
      </div>
      <div className="text-[10px] font-mono text-zinc-300 leading-relaxed mb-1">
        <span className="text-zinc-500 uppercase tracking-[0.15em] text-[8px]">value</span>{' '}
        {row.offendingValue}
      </div>
      {row.expectedRange && (
        <div className="text-[10px] font-mono text-zinc-300 leading-relaxed mb-1">
          <span className="text-zinc-500 uppercase tracking-[0.15em] text-[8px]">expected</span>{' '}
          {row.expectedRange}
        </div>
      )}
      <div className="text-[10px] font-mono text-zinc-200 leading-relaxed mb-2">
        <span className="text-zinc-500 uppercase tracking-[0.15em] text-[8px]">explanation</span>{' '}
        {row.explanation}
      </div>
      {row.operatorAction && (
        <div className="text-[10px] font-mono text-zinc-100 leading-relaxed">
          <span className="text-zinc-500 uppercase tracking-[0.15em] text-[8px]">operator action</span>{' '}
          {row.operatorAction}
        </div>
      )}
      {row.resolutionNote && (
        <div className="text-[10px] font-mono text-emerald-200/70 leading-relaxed mt-1">
          <span className="text-zinc-500 uppercase tracking-[0.15em] text-[8px]">resolution</span>{' '}
          {row.resolutionNote}
          {row.resolvedBy && (
            <span className="text-zinc-500"> (by {row.resolvedBy})</span>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: QuarantineStatus }) {
  const map: Record<QuarantineStatus, { bg: string; border: string; text: string }> = {
    pending: { bg: 'bg-red-500/10', border: 'border-red-500/40', text: 'text-red-300' },
    'accepted-as-warning': { bg: 'bg-amber-500/10', border: 'border-amber-500/40', text: 'text-amber-300' },
    approved: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/40', text: 'text-emerald-300' },
    corrected: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/40', text: 'text-emerald-300' },
    'auto-fixed': { bg: 'bg-zinc-500/10', border: 'border-zinc-500/40', text: 'text-zinc-300' },
  };
  const cls = map[status];
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded border text-[8px] font-bold uppercase tracking-[0.15em] ${cls.bg} ${cls.border} ${cls.text}`}>
      {status}
    </span>
  );
}

/**
 * Render the Tier-1 auto-fix log for the last 24h. Brief rows (no full
 * explanation by default — that's the QuarantinePanel's job). Empty state
 * is the common case in v1 because nothing auto-inserts yet; Phase 2 v2
 * probes are what start populating this.
 */
function AutoFixLogPanel({ data }: { data: QuarantineSummary | null }) {
  if (data === null) return null; // table absent — banner is in QuarantinePanel
  const rows = data.recentTier1AutofixRows;
  return (
    <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">
          Auto-fix log · last 24h · {data.tier1AutofixLast24hCount} rows
        </div>
        <div className="text-[9px] font-mono text-zinc-500">
          ADR-044 Tier-1 mechanical fixes (no operator gate)
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="text-[11px] font-mono text-emerald-400/80">
          No Tier-1 auto-fixes in last 24h.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map(row => (
            <div
              key={row.id}
              className="border border-zinc-500/30 bg-zinc-500/5 rounded p-2"
            >
              <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
                <div className="text-[10px] font-mono text-zinc-200 font-bold">
                  {row.sourceLabel}{' '}
                  <span className="text-zinc-500 font-normal">·</span>{' '}
                  <span className="font-normal">{row.category}</span>
                </div>
                <div className="text-[9px] font-mono text-zinc-500">
                  {formatRelative(row.detectedAt)} · source quantlab.{row.sourceTable}
                </div>
              </div>
              <div className="text-[10px] font-mono text-zinc-300 leading-relaxed">
                {row.explanation}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Phase3Footer() {
  return (
    <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4 opacity-60">
      <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500 mb-2">
        Phase 2 v2 (deferred)
      </div>
      <ul className="text-[10px] font-mono text-zinc-500 leading-relaxed space-y-1">
        <li>
          • <span className="text-zinc-400">Plausibility-band probes</span> —
          per-composite sigma-bounded checks (937T% return class) that
          auto-insert Tier-2 quarantine rows when outputs exit expected
          ranges (ADR-044 §infrastructure-1).
        </li>
        <li>
          • <span className="text-zinc-400">Per-UI-route ping</span> —
          200-status probe of every Express route; non-200 auto-inserts
          a Tier-1 row + (Phase 2 v2) attempts the table-exists guard.
        </li>
        <li>
          • <span className="text-zinc-400">Auto-insert logic</span> on
          probe anomaly so the log + queue populate without manual
          ingestion.
        </li>
      </ul>
      <div className="mt-3 text-[10px] font-mono text-zinc-500 leading-relaxed">
        Cycle 3 Workers <span className="text-zinc-400">B + C</span> complete
        the Phase 2 v1 operator-facing surface: brief §0 daily digest, daemon
        step 0a (auto-run health check), Telegram alerts on Tier-2 quarantine
        events.
      </div>
    </div>
  );
}

// ── Badge components ───────────────────────────────────────────────────────

function StatusBadge({ status }: { status: HealthStatus }) {
  const map: Record<HealthStatus, { bg: string; border: string; text: string; label: string }> = {
    'fresh': { bg: 'bg-emerald-500/10', border: 'border-emerald-500/40', text: 'text-emerald-300', label: 'fresh' },
    'stale': { bg: 'bg-amber-500/10', border: 'border-amber-500/40', text: 'text-amber-300', label: 'stale' },
    'very-stale': { bg: 'bg-red-500/10', border: 'border-red-500/40', text: 'text-red-300', label: 'very stale' },
    'missing-table': { bg: 'bg-red-500/10', border: 'border-red-500/40', text: 'text-red-300', label: 'missing' },
    'never-populated': { bg: 'bg-amber-500/10', border: 'border-amber-500/40', text: 'text-amber-300', label: 'empty' },
    'unknown-cadence': { bg: 'bg-zinc-500/10', border: 'border-zinc-500/40', text: 'text-zinc-300', label: 'unknown' },
  };
  const cls = map[status];
  return (
    <span className={`inline-block px-2 py-0.5 rounded border text-[9px] font-bold uppercase tracking-[0.15em] ${cls.bg} ${cls.border} ${cls.text}`}>
      {cls.label}
    </span>
  );
}

function CadenceBadge({ cadence }: { cadence: HealthCadence }) {
  return (
    <span className="text-[9px] font-mono uppercase tracking-[0.15em] text-zinc-400">
      {cadence}
    </span>
  );
}

function RefreshBadge({ autonomous }: { autonomous: boolean }) {
  if (autonomous) {
    return (
      <span className="inline-block px-1.5 py-0.5 rounded border text-[8px] font-bold uppercase tracking-[0.15em] bg-emerald-500/10 border-emerald-500/40 text-emerald-300">
        daemon
      </span>
    );
  }
  return (
    <span
      className="inline-block px-1.5 py-0.5 rounded border text-[8px] font-bold uppercase tracking-[0.15em] bg-amber-500/10 border-amber-500/40 text-amber-300"
      title="Operator must remember to run the ingest. Reconciliation GAP-1/2/3/4."
    >
      operator
    </span>
  );
}

// ── Formatting helpers ─────────────────────────────────────────────────────
// All numeric formatters guard non-finite inputs to prevent NaN%/Infinity
// rendering (ADR-044 UI-correctness domain).

function formatAge(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  if (days < 14) return `${days.toFixed(1)}d`;
  return `${Math.round(days)}d`;
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const ageMs = Date.now() - t;
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours < 0) return 'in the future';
  if (ageHours < 1 / 60) return 'just now';
  if (ageHours < 1) return `${Math.round(ageHours * 60)}m ago`;
  if (ageHours < 48) return `${ageHours.toFixed(1)}h ago`;
  const days = ageHours / 24;
  if (days < 14) return `${days.toFixed(1)}d ago`;
  return `${Math.round(days)}d ago`;
}
