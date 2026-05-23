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
            <FreshnessPanel sources={state.data.sources} />
            <MigrationsPanel migrations={state.data.migrations} />
            <Phase2Footer />
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
        ADR-044 · phase 1
      </div>
      <div className="text-[11px] font-mono text-emerald-100/80 leading-relaxed">
        Read-only health surface. Per-source freshness vs expected cadence,
        plus operator-pending migrations. <span className="text-emerald-300 font-bold">
        Phase 2</span> adds the quarantine queue + Telegram alerts + auto-fix
        log once this read-only foundation is browser-validated. SPEC:{' '}
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

function Phase2Footer() {
  return (
    <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4 opacity-60">
      <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500 mb-2">
        Phase 2 (next slice, post-browser-validation)
      </div>
      <ul className="text-[10px] font-mono text-zinc-500 leading-relaxed space-y-1">
        <li>
          • <span className="text-zinc-400">Quarantine queue</span> —
          Tier-2 correctness anomalies persist to <code>quantlab.health_quarantine</code>;
          operator resolves (approved / corrected / accepted-as-warning).
        </li>
        <li>
          • <span className="text-zinc-400">Auto-fix log</span> — rolling
          24h log of Tier-1 mechanical fixes applied without operator gate.
        </li>
        <li>
          • <span className="text-zinc-400">Telegram alerts</span> — one
          alert per Tier-2 quarantine event; Tier-1 fixes roll up in the
          morning brief §0 daily digest.
        </li>
        <li>
          • <span className="text-zinc-400">Daemon step 0a</span> —
          auto-run health check at start of <code>daemon:daily</code>;
          surface critical findings in the brief.
        </li>
      </ul>
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
