/**
 * Phase B verdict dashboard — ADR-051 §Decision 7 read-only surface
 * (Cycle 24 UI+Health worker).
 *
 * Mounted by main.tsx when location.hash matches "#/phase-b". Reads from
 * `/api/phase_b/state` (powered by `src/server/phase_b_dashboard.ts`).
 *
 * Visual layout — Bloomberg-style information density per Vector Core
 * DESIGN guidance:
 *   1. Top summary banner — composite counts + verdict-tier counts +
 *      Phase-C-eligible roster (the operator-queue surface).
 *   2. Composite verdict matrix — one row per composite, one column per
 *      benchmark. Each cell shows:
 *         - verdict label (color-coded: green=pass-all, yellow=partial,
 *           red=fail, gray=insufficient)
 *         - phase_c_eligible chip
 *         - four-gate sparkline: DSR / PBO / HLZ / OOS-IS with pass/fail
 *           indicators
 *         - notes on hover
 *   3. Composites awaiting first campaign — surfaces the queue of
 *      composites that have no verdict rows yet, with their per-composite
 *      SPEC path so the operator can see the planned scope.
 *
 * Numeric-formatter discipline (per ADR-044 UI correctness domain +
 * GAP-12 hygiene): every `toFixed` is wrapped in `fmt()` which guards
 * `Number.isFinite`. A null / NaN / Infinity input renders as `'—'`.
 *
 * Drill-in: Per ADR-051 §Decision 7 the drill-in shows per-trial-Sharpe
 * distribution, equity curve, CSCV omega distribution, and per-gate
 * intuition/explanation text. The current slice ships the top-level
 * verdict matrix only and stubs the drill-in with an info card that
 * documents the deferred scope; the drill-in is a follow-up cycle.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  PhaseBDashboardResponse,
  PhaseBDashboardComposite,
  PhaseBDashboardCell,
  PhaseBVerdict,
} from '../../server/phase_b_dashboard.js';

interface State {
  data: PhaseBDashboardResponse | null;
  loading: boolean;
  error: string | null;
}

export default function PhaseBApp() {
  const [state, setState] = useState<State>({
    data: null,
    loading: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const r = await fetch('/api/phase_b/state');
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
      const data = await r.json() as PhaseBDashboardResponse;
      setState({ data, loading: false, error: null });
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const headerStatus = state.data?.topLevelStatus;
  const headerDotClass =
    headerStatus === 'ok' && (state.data?.summary.phaseCEligibleCount ?? 0) > 0
      ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]'
      : headerStatus === 'ok'
      ? 'bg-amber-400 shadow-[0_0_10px_rgba(250,204,21,0.5)]'
      : headerStatus === 'no-verdicts' || headerStatus === 'table-absent'
      ? 'bg-zinc-500 shadow-[0_0_10px_rgba(160,160,160,0.4)]'
      : 'bg-red-400 shadow-[0_0_10px_rgba(248,113,113,0.5)]';

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <header className="h-16 border-b border-[#1a1a1a] flex items-center justify-between px-8 bg-black sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full animate-pulse ${headerDotClass}`} />
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-white italic">
            VECTOR_PHASE_B · Layer-0 Deflation Pipeline Verdicts
          </h2>
          {state.data && (
            <span className="text-[10px] font-mono text-zinc-500 ml-2">
              ADR-051 · {state.data.summary.compositesWithVerdicts}/{state.data.composites.length} composites · generated {formatRelative(state.data.generatedAt)}
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
            {state.loading ? 'reading…' : 'refresh'}
          </button>
        </div>
      </header>

      <main className="p-6 max-w-[1600px] mx-auto">
        {state.error && (
          <div className="border border-red-500/40 bg-red-500/10 rounded p-4 mb-4">
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-red-300 mb-1">
              Failed to load Phase B verdicts
            </div>
            <div className="text-[11px] font-mono text-red-200/80">{state.error}</div>
            <div className="text-[10px] font-mono text-red-200/60 mt-2">
              Try refreshing. If the error persists, check that <code className="text-red-200">quantlab.phase_b_verdicts</code>{' '}
              exists by running <code className="text-red-200">npm run migrate:create-phase-b-verdicts:apply</code>.
            </div>
          </div>
        )}

        {state.loading && !state.data && (
          <div className="text-[11px] font-mono text-zinc-500">reading Phase B verdicts…</div>
        )}

        {state.data && (
          <div className="flex flex-col gap-6">
            <SpecBanner />
            {state.data.topLevelStatus === 'read-failed' && (
              <ReadFailedBanner error={state.data.error} />
            )}
            {state.data.topLevelStatus === 'table-absent' && (
              <TableAbsentBanner />
            )}
            {state.data.topLevelStatus === 'no-verdicts' && (
              <NoVerdictsBanner />
            )}
            {state.data.topLevelStatus === 'ok' && (
              <>
                <SummaryBanner data={state.data} />
                <CompositeMatrix composites={state.data.composites} />
              </>
            )}
            <DrillInDeferredFooter />
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
        ADR-051 · Layer-0 Phase B
      </div>
      <div className="text-[11px] font-mono text-emerald-100/80 leading-relaxed">
        Four-gate deflation pipeline (DSR / PBO / HLZ / Pardo OOS-IS) per AFML §11,
        Bailey-LdP 2014, Harvey-Liu-Zhu 2016, Pardo 2008. A composite is{' '}
        <span className="text-emerald-300 font-bold">Phase-C-eligible</span> iff
        ≥1 (composite × benchmark) cell has all four gates pass AND PBO &lt; 0.2.
        Anti-shopping rule: a failed Phase B closes the v1 composite; a v2
        redesign requires independent canon-cited evidence. SPEC:{' '}
        <code className="text-emerald-300">docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md</code>.
      </div>
    </div>
  );
}

function ReadFailedBanner({ error }: { error: string }) {
  return (
    <div className="border border-red-500/40 bg-red-500/10 rounded-xl p-4">
      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-red-300 mb-2">
        Verdict read failed
      </div>
      <div className="text-[11px] font-mono text-red-200/80 leading-relaxed">{error}</div>
    </div>
  );
}

function TableAbsentBanner() {
  return (
    <div className="border border-amber-500/40 bg-amber-500/5 rounded-xl p-4">
      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-300 mb-2">
        Phase B verdicts table not initialized
      </div>
      <div className="text-[11px] font-mono text-amber-100/80 leading-relaxed">
        <code className="text-amber-300">quantlab.phase_b_verdicts</code> is absent.
        Apply the migration and then run the first per-composite campaign:
      </div>
      <div className="mt-2 flex flex-col gap-1">
        <code className="text-[10px] font-mono text-amber-200 bg-black/40 border border-amber-500/20 rounded px-2 py-1">
          npm run migrate:create-phase-b-trials:apply
        </code>
        <code className="text-[10px] font-mono text-amber-200 bg-black/40 border border-amber-500/20 rounded px-2 py-1">
          npm run migrate:create-phase-b-verdicts:apply
        </code>
        <code className="text-[10px] font-mono text-amber-200 bg-black/40 border border-amber-500/20 rounded px-2 py-1">
          npm run phase_b:cycle_v1:apply
        </code>
      </div>
    </div>
  );
}

function NoVerdictsBanner() {
  return (
    <div className="border border-zinc-500/40 bg-zinc-500/5 rounded-xl p-4">
      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-300 mb-2">
        Awaiting first campaign
      </div>
      <div className="text-[11px] font-mono text-zinc-200/80 leading-relaxed">
        The verdicts table exists but no Phase B campaign has been run yet.
        Run the first per-composite campaign to populate verdicts:
      </div>
      <code className="text-[10px] font-mono text-zinc-200 bg-black/40 border border-zinc-500/20 rounded px-2 py-1 mt-2 inline-block">
        npm run phase_b:cycle_v1:apply
      </code>
    </div>
  );
}

function SummaryBanner({ data }: { data: PhaseBDashboardResponse }) {
  const { summary } = data;
  const tiles: Array<{ label: string; value: number; color: string; emphasis: boolean }> = [
    { label: 'Composites', value: data.composites.length, color: 'text-zinc-300', emphasis: false },
    { label: 'With verdicts', value: summary.compositesWithVerdicts, color: 'text-zinc-300', emphasis: false },
    { label: 'Total cells', value: summary.totalCells, color: 'text-zinc-300', emphasis: false },
    { label: 'PASS-ALL', value: summary.passAllCount, color: 'text-emerald-300', emphasis: summary.passAllCount > 0 },
    { label: 'Partial', value: summary.partialCount, color: 'text-amber-300', emphasis: summary.partialCount > 0 },
    { label: 'Fail', value: summary.failCount, color: 'text-red-300', emphasis: summary.failCount > 0 },
    { label: 'Insufficient', value: summary.insufficientCount, color: 'text-zinc-400', emphasis: summary.insufficientCount > 0 },
    { label: 'Phase-C eligible', value: summary.phaseCEligibleCount, color: 'text-emerald-300', emphasis: summary.phaseCEligibleCount > 0 },
  ];
  return (
    <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">
          Summary
        </div>
        <div className={`text-[10px] font-mono font-bold uppercase tracking-[0.2em] ${summary.phaseCEligibleCount > 0 ? 'text-emerald-300' : 'text-amber-300'}`}>
          {summary.phaseCEligibleCount > 0
            ? `${summary.phaseCEligibleCount} cell(s) Phase-C eligible — operator queue`
            : 'No Phase-C-eligible composites'}
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
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
      {summary.phaseCEligible.length > 0 && (
        <div className="mt-3 pt-3 border-t border-[#1a1a1a]">
          <div className="text-[9px] font-mono uppercase tracking-[0.15em] text-emerald-300/80 mb-1">
            Phase-C-eligible cells (route to operator queue)
          </div>
          <div className="flex flex-wrap gap-2">
            {summary.phaseCEligible.map(p => (
              <span
                key={`${p.compositeVersion}-${p.benchmark}`}
                className="text-[10px] font-mono px-2 py-0.5 rounded border bg-emerald-500/10 border-emerald-500/40 text-emerald-200"
              >
                {p.compositeVersion} × {p.benchmark}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CompositeMatrix({ composites }: { composites: ReadonlyArray<PhaseBDashboardComposite> }) {
  // Display composites with verdicts first, then composites awaiting first
  // campaign. Within each tier sort by KNOWN_COMPOSITES order (server
  // already returns them in that order).
  const withVerdicts = composites.filter(c => c.cells.length > 0);
  const awaiting = composites.filter(c => c.cells.length === 0);
  return (
    <div className="flex flex-col gap-4">
      {withVerdicts.length > 0 && (
        <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4">
          <div className="flex items-baseline justify-between mb-3">
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">
              Verdict matrix · {withVerdicts.length} composite{withVerdicts.length === 1 ? '' : 's'} with results
            </div>
            <div className="text-[9px] font-mono text-zinc-500">
              one row per composite · one cell per benchmark · four-gate breakdown
            </div>
          </div>
          <div className="flex flex-col gap-3">
            {withVerdicts.map(c => (
              <div key={c.compositeVersion}>
                <CompositeRow composite={c} />
              </div>
            ))}
          </div>
        </div>
      )}
      {awaiting.length > 0 && (
        <details className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4 group">
          <summary className="cursor-pointer list-none flex items-baseline justify-between hover:text-zinc-200 transition-colors">
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500">
              Awaiting first campaign · {awaiting.length} composite{awaiting.length === 1 ? '' : 's'}
            </div>
            <span className="text-[9px] font-mono text-zinc-500">▶ expand</span>
          </summary>
          <div className="mt-3 flex flex-col gap-2">
            {awaiting.map(c => (
              <div key={c.compositeVersion}>
                <AwaitingCompositeRow composite={c} />
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function CompositeRow({ composite }: { composite: PhaseBDashboardComposite }) {
  const { rollup } = composite;
  return (
    <div className="border border-[#1a1a1a] rounded bg-black/40 p-3">
      <div className="flex items-baseline justify-between mb-2 gap-3 flex-wrap">
        <div className="flex items-baseline gap-2">
          <div className="text-[12px] font-mono text-white font-bold">{composite.label}</div>
          <div className="text-[9px] font-mono text-zinc-500">
            {composite.compositeVersion}
          </div>
          <div className="text-[8px] font-mono text-zinc-600 uppercase tracking-[0.15em]">
            {composite.adrRef}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {rollup.bestVerdict && (
            <span className="text-[8px] font-mono text-zinc-500 uppercase tracking-[0.15em]">
              best: <VerdictBadge verdict={rollup.bestVerdict} compact />
            </span>
          )}
          {rollup.worstVerdict && rollup.worstVerdict !== rollup.bestVerdict && (
            <span className="text-[8px] font-mono text-zinc-500 uppercase tracking-[0.15em]">
              worst: <VerdictBadge verdict={rollup.worstVerdict} compact />
            </span>
          )}
          {rollup.anyPhaseCEligible && (
            <span className="text-[9px] font-mono px-2 py-0.5 rounded border bg-emerald-500/10 border-emerald-500/40 text-emerald-200">
              {rollup.phaseCEligibleCount} Phase-C eligible
            </span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
        {composite.cells.map(cell => (
          <div key={`${cell.compositeVersion}-${cell.benchmark}`}>
            <CellCard cell={cell} />
          </div>
        ))}
      </div>
    </div>
  );
}

function CellCard({ cell }: { cell: PhaseBDashboardCell }) {
  const verdictTone = VERDICT_TONE[cell.verdict];
  return (
    <div className={`border ${verdictTone.border} ${verdictTone.bg} rounded p-2`}>
      <div className="flex items-baseline justify-between mb-1 gap-2">
        <div className="flex items-baseline gap-2">
          <div className="text-[11px] font-mono text-white font-bold">{cell.benchmark}</div>
          <VerdictBadge verdict={cell.verdict} />
        </div>
        {cell.phaseCEligible && (
          <span className="text-[8px] font-mono px-1.5 py-0.5 rounded border bg-emerald-500/10 border-emerald-500/40 text-emerald-300 uppercase tracking-[0.15em] font-bold">
            Phase-C
          </span>
        )}
      </div>
      <div className="text-[9px] font-mono text-zinc-400 mb-1">
        θ*={fmt(cell.bestTrialTheta)} · IS={fmt(cell.bestIsSharpe)} · OOS={fmt(cell.bestOosSharpe)}
      </div>
      <div className="grid grid-cols-4 gap-1">
        <GateChip label="DSR" value={fmt(cell.dsrValue)} pass={cell.dsrPass} />
        <GateChip label="PBO" value={fmt(cell.pboValue)} pass={cell.pboPass} invertSign />
        <GateChip
          label="HLZ"
          value={`${fmtT(cell.hlzTStat)}/${fmtT(cell.hlzThreshold)}`}
          pass={cell.hlzPass}
        />
        <GateChip label="OOS/IS" value={fmt(cell.oosIsRatio)} pass={cell.oosIsPass} />
      </div>
      {cell.notes && (
        <div className="mt-1 text-[8px] font-mono text-zinc-500 italic truncate" title={cell.notes}>
          {cell.notes}
        </div>
      )}
    </div>
  );
}

function GateChip({
  label,
  value,
  pass,
  invertSign,
}: {
  label: string;
  value: string;
  pass: boolean;
  /** For PBO where pass = value < threshold (low value is good). */
  invertSign?: boolean;
}) {
  void invertSign; // kept in signature for future styling hooks (PBO is the
  // only inverted gate; gate pass/fail is the right summary signal for v1).
  const tone = pass ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-red-500/40 bg-red-500/10 text-red-200';
  const mark = pass ? '✓' : '✗';
  return (
    <div className={`border rounded px-1.5 py-0.5 ${tone}`}>
      <div className="text-[7px] font-mono uppercase tracking-[0.15em] opacity-60">{label}</div>
      <div className="text-[10px] font-mono font-bold leading-tight">
        {mark} {value}
      </div>
    </div>
  );
}

const VERDICT_TONE: Record<PhaseBVerdict, { bg: string; border: string; text: string }> = {
  'pass-all':     { bg: 'bg-emerald-500/5', border: 'border-emerald-500/30', text: 'text-emerald-200' },
  'partial':      { bg: 'bg-amber-500/5',   border: 'border-amber-500/30',   text: 'text-amber-200' },
  'fail':         { bg: 'bg-red-500/5',     border: 'border-red-500/30',     text: 'text-red-200' },
  'insufficient': { bg: 'bg-zinc-500/5',    border: 'border-zinc-500/30',    text: 'text-zinc-300' },
};

function VerdictBadge({ verdict, compact }: { verdict: PhaseBVerdict; compact?: boolean }) {
  const tone = VERDICT_TONE[verdict];
  const label =
    verdict === 'pass-all'     ? 'PASS-ALL'
    : verdict === 'partial'    ? 'PARTIAL'
    : verdict === 'fail'       ? 'FAIL'
    : 'INSUFFICIENT';
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded border text-[8px] font-bold uppercase tracking-[0.15em] ${tone.bg} ${tone.border} ${tone.text} ${compact ? 'ml-1' : ''}`}>
      {label}
    </span>
  );
}

function AwaitingCompositeRow({ composite }: { composite: PhaseBDashboardComposite }) {
  return (
    <div className="border border-zinc-500/20 bg-zinc-500/5 rounded px-3 py-2 flex items-baseline justify-between gap-3 flex-wrap">
      <div className="flex items-baseline gap-2">
        <div className="text-[11px] font-mono text-zinc-300 font-bold">{composite.label}</div>
        <div className="text-[9px] font-mono text-zinc-500">{composite.compositeVersion}</div>
      </div>
      <div className="text-[9px] font-mono text-zinc-500">
        spec: <code className="text-zinc-400">{composite.specPath}</code>
      </div>
    </div>
  );
}

function DrillInDeferredFooter() {
  return (
    <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4 opacity-60">
      <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500 mb-2">
        Drill-in (deferred to follow-up cycle)
      </div>
      <ul className="text-[10px] font-mono text-zinc-500 leading-relaxed space-y-1">
        <li>
          • <span className="text-zinc-400">Per-trial Sharpe distribution</span> across the 19-θ
          grid per (composite × benchmark), with the IS-best trial highlighted.
        </li>
        <li>
          • <span className="text-zinc-400">IS equity curve</span> of the best
          trial — eyeball regime-period behavior.
        </li>
        <li>
          • <span className="text-zinc-400">CSCV omega distribution</span> from
          the PBO probe — visual check that the IS ranking generalizes.
        </li>
        <li>
          • <span className="text-zinc-400">Per-gate intuition / failure-mode text</span>{' '}
          (produced by <code className="text-zinc-400">validator.ts</code>{' '}
          <code className="text-zinc-400">GateOutcome</code>) explaining what
          each verdict means in plain language.
        </li>
      </ul>
      <div className="mt-3 text-[10px] font-mono text-zinc-500 leading-relaxed">
        Per ADR-051 §Decision 7 the drill-in is a follow-up cycle on top of
        the top-level verdict matrix. The trial-distribution reconstruction
        reads from <code className="text-zinc-400">quantlab.phase_b_trials</code>{' '}
        (57 rows per cycle_v1 campaign run).
      </div>
    </div>
  );
}

// ── Formatting helpers ─────────────────────────────────────────────────────
// All numeric formatters guard non-finite inputs to prevent NaN/Infinity
// rendering (ADR-044 UI-correctness domain + GAP-12 hygiene).

/** Render a 3-decimal number, or '—' for null/NaN/Infinity inputs. */
function fmt(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v.toFixed(3);
}

/** Render a 2-decimal t-stat (HLZ values run 2-4); '—' for non-finite. */
function fmtT(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v.toFixed(2);
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
