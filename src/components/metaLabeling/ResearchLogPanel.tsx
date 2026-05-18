/**
 * Research-log table — one row per meta-labeling cell-training in
 * `quantlab.meta_models` (FINAL by `(cell_key, m1_run_sig)`). Self-fetches
 * /api/meta-labeling/cells on mount.
 *
 * Render branches:
 *   loading                  → skeleton
 *   error                    → red-bordered card
 *   data, rows.length === 0  → yellow "no trainings yet" card
 *   data, rows.length > 0    → header (summary chips) + row table
 *
 * **Schema migration 2026-05-05:** the trainer now persists the full 7-criterion
 * verdict (c1..c7 pass flags + distribution stats + verdict_text). When
 * `verdictPersisted` is true on a row, all 7 pills render authoritatively.
 * Older rows (where verdict_text was DEFAULT '') fall back to partial-pill
 * rendering — currently no such rows exist after the 2026-05-05 backfill,
 * but the safety path stays in code.
 */
import { useEffect, useState } from 'react';
import type { MetaLabelingResponse, MetaLabelingRow } from '../../server/meta_labeling_dashboard.js';

interface State {
  data: MetaLabelingResponse | null;
  loading: boolean;
  error: string | null;
}

const formatPct = (n: number): string => {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
};

const formatLift = (n: number): string => {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}pp`;
};

const formatAuc = (n: number): string => n.toFixed(4);

const formatDate = (iso: string): string => iso.slice(0, 10);

const netColor = (n: number): string => {
  if (n > 0.5) return 'text-emerald-300';
  if (n < -0.5) return 'text-red-300';
  return 'text-zinc-300';
};

interface PillProps {
  label: string;
  pass: boolean;
  value?: string;
  title?: string;
}

function Pill({ label, pass, value, title }: PillProps) {
  const bg = pass
    ? 'bg-emerald-500/10 border-emerald-400/30 text-emerald-300'
    : 'bg-red-500/10 border-red-400/30 text-red-300';
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-mono ${bg}`}
      title={title}
    >
      <span className="font-black">{label}</span>
      {value !== undefined && <span>{value}</span>}
    </span>
  );
}

function VerdictBadge({ row }: { row: MetaLabelingRow }) {
  if (!row.verdictPersisted) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-zinc-600 bg-zinc-800/50 text-[10px] font-mono text-zinc-400"
        title="Verdict not persisted (legacy row pre-schema-migration)"
      >
        partial
      </span>
    );
  }
  const verdict = row.verdictText;
  let cls: string;
  if (verdict === 'PROMOTE') {
    cls = 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200';
  } else if (verdict.startsWith('REJECT')) {
    cls = 'border-red-400/30 bg-red-500/10 text-red-300';
  } else if (verdict.startsWith('PARTIAL')) {
    cls = 'border-yellow-400/30 bg-yellow-500/10 text-yellow-300';
  } else {
    cls = 'border-zinc-600 bg-zinc-800/50 text-zinc-300';
  }
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-mono ${cls}`}
      title={`Full 7-criterion verdict: ${row.nPass}/7 pass`}
    >
      {verdict}
    </span>
  );
}

/**
 * Click-to-copy button for the m1_run_sig. Feeds the user's "review via docs"
 * workflow — they grep `docs/experiments/` for the sig to find the captured
 * stdout for any given row. Falls back to a static span if the Clipboard API
 * is unavailable (older browsers / non-secure contexts).
 */
function SigCopy({ sig }: { sig: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(sig);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable — leave the badge clickable but inert.
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={`m1_run_sig: ${sig} — click to copy (grep \`docs/experiments/\` for captured stdout)`}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-zinc-700/60 bg-zinc-900/40 hover:bg-zinc-800 hover:border-zinc-600 text-[9px] font-mono text-zinc-400 transition-colors"
    >
      <span className="text-violet-300/80">sig</span>
      <span>{sig.slice(0, 8)}</span>
      <span className={copied ? 'text-emerald-300' : 'text-zinc-500'}>
        {copied ? '✓' : '⎘'}
      </span>
    </button>
  );
}

function renderRow(row: MetaLabelingRow) {
  const [strategy, tier, interval, param] = row.cellKey.split('|');
  return (
    <tr key={`${row.cellKey}|${row.m1RunSig}`} className="border-b border-[#1a1a1a] hover:bg-zinc-900/40 transition-colors">
      <td className="px-3 py-2 text-[11px] font-mono whitespace-nowrap">
        <div className="text-white">{strategy}</div>
        <div className="text-zinc-500 text-[10px]">
          {tier} · {interval} · p={param}
        </div>
        <div className="mt-1">
          <SigCopy sig={row.m1RunSig} />
        </div>
      </td>
      <td className="px-3 py-2 text-[10px] font-mono text-zinc-400 whitespace-nowrap">{formatDate(row.trainedAt)}</td>
      <td className="px-3 py-2 text-[11px] font-mono text-zinc-300 text-right">{row.nOos.toLocaleString()}</td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          <Pill label="C1" pass={row.c1Pass} value={formatAuc(row.aucOos)} title="AUC ≥ 0.55" />
          <Pill label="C2" pass={row.c2Pass} value={String(row.oosKeptTrades)} title="kept ≥ 100" />
          {row.verdictPersisted && (
            <>
              <Pill label="C3" pass={row.c3Pass} title="M2 per-trade > M1 per-trade" />
              <Pill label="C4" pass={row.c4Pass} title="M2 sum > 0" />
              <Pill label="C5" pass={row.c5Pass} title="trimmed-mean > 0" />
              <Pill label="C6" pass={row.c6Pass} title="top-1 share ≤ 50%" />
              <Pill label="C7" pass={row.c7Pass} title="t-stat ≥ HLZ bar" />
            </>
          )}
        </div>
      </td>
      <td className={`px-3 py-2 text-[11px] font-mono text-right whitespace-nowrap ${netColor(row.oosKeptNetPct)}`}>
        {formatPct(row.oosKeptNetPct)}
      </td>
      <td className={`px-3 py-2 text-[11px] font-mono text-right whitespace-nowrap ${netColor(row.m1OosNetPct)}`}>
        {formatPct(row.m1OosNetPct)}
      </td>
      <td className={`px-3 py-2 text-[11px] font-mono text-right whitespace-nowrap ${row.liftPct > 0 ? 'text-emerald-300' : 'text-red-300'}`}>
        {formatLift(row.liftPct)}
      </td>
      <td className="px-3 py-2">
        <VerdictBadge row={row} />
      </td>
    </tr>
  );
}

export default function ResearchLogPanel() {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/meta-labeling/cells')
      .then(async r => {
        if (!r.ok) {
          const detail = await r.text().catch(() => '');
          throw new Error(`${r.status} ${r.statusText}${detail ? ` — ${detail.slice(0, 240)}` : ''}`);
        }
        return r.json() as Promise<MetaLabelingResponse>;
      })
      .then(data => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch(err => {
        if (cancelled) return;
        setState({ data: null, loading: false, error: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, []);

  if (state.loading) {
    return (
      <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-2xl p-6">
        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-violet-400/70 mb-4">Research Log</h3>
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-10 bg-zinc-800/40 rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="bg-[#0a0a0a] border border-red-500/30 rounded-2xl p-6">
        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-red-400 mb-2">Research Log</h3>
        <p className="text-[11px] font-mono text-red-200/80">
          Meta-labeling research log unavailable — <span className="text-red-300">{state.error}</span>
        </p>
      </div>
    );
  }

  if (!state.data || state.data.rows.length === 0) {
    return (
      <div className="bg-[#0a0a0a] border border-yellow-500/30 rounded-2xl p-6">
        <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-yellow-400 mb-2">Research Log</h3>
        <p className="text-[11px] font-mono text-yellow-200/80">
          No meta-labeling trainings yet. Run{' '}
          <code className="text-cyan-300">.venv/Scripts/python.exe scripts/train_meta_label.py --cell-key &apos;...&apos; --m1-run-sig ...</code>{' '}
          to populate.
        </p>
      </div>
    );
  }

  const { summary, rows } = state.data;

  return (
    <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-2xl p-6">
      {/* Header + summary chips */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-violet-400/70">Research Log</h3>
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-mono text-zinc-500">
              {summary.total} cell-training{summary.total === 1 ? '' : 's'}{' '}
              ({summary.verdictPersistedCount} with full verdict)
            </span>
            <span
              className="text-[9px] font-mono text-zinc-500 italic"
              title="Per-row sig is a clickable click-to-copy badge. Paste it into a grep against docs/experiments/ to find the captured stdout for that training."
            >
              experiment logs in <code className="text-cyan-300/80">docs/experiments/</code> · grep by sig or trained_at date
            </span>
          </div>
        </div>

        {/* Per-criterion summary chips */}
        <div className="flex flex-wrap gap-2 mb-3">
          {(
            [
              ['C1', summary.c1Pass, 'AUC ≥ 0.55'],
              ['C2', summary.c2Pass, 'kept ≥ 100'],
              ['C3', summary.c3Pass, 'per-trade lift'],
              ['C4', summary.c4Pass, 'M2 sum > 0'],
              ['C5', summary.c5Pass, 'trimmed-mean > 0'],
              ['C6', summary.c6Pass, 'top-1 ≤ 50%'],
              ['C7', summary.c7Pass, 't-stat ≥ HLZ bar'],
            ] as const
          ).map(([label, count, hint]) => (
            <span
              key={label}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 bg-zinc-900/40 text-[10px] font-mono text-zinc-300"
              title={hint}
            >
              <span className="font-black text-violet-300">{label}</span>
              <span>{count}/{summary.total}</span>
            </span>
          ))}
          <span
            className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-mono ${
              summary.allPass === 0
                ? 'border-red-400/30 bg-red-500/10 text-red-300'
                : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
            }`}
            title="Cells passing all 7 criteria (PROMOTE)"
          >
            <span className="font-black">PROMOTE</span>
            <span>{summary.allPass}/{summary.total}</span>
          </span>
        </div>

        {/* Honest framing — adapts based on whether verdicts are persisted. */}
        <p className="text-[10px] font-mono text-zinc-500 leading-relaxed">
          {summary.verdictPersistedCount === summary.total ? (
            <>
              <span className="text-zinc-400">Full 7-criterion verdict persisted for all rows.</span>{' '}
              Pills are authoritative — pass flags + distribution stats from the trainer&apos;s runtime
              evaluation are stored in <code className="text-zinc-400">meta_models</code> per the
              2026-05-05 schema migration.
              {summary.allPass === 0 && (
                <>
                  {' '}
                  <span className="text-red-300">
                    0 of {summary.total} cells PROMOTE — system rejecting everything that should be
                    rejected (per-canon expected on noisy / regime-mismatched universes; see ADR-025).
                  </span>
                </>
              )}
            </>
          ) : (
            <>
              <span className="text-zinc-400">Mixed verdict-persistence.</span>{' '}
              {summary.verdictPersistedCount} of {summary.total} cells have full 7-criterion verdict
              persisted; the rest show partial pills (C1/C2/C4 only) — re-run trainer on those cells
              to populate the full verdict.
            </>
          )}
        </p>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className="px-3 py-2 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500">Cell</th>
              <th className="px-3 py-2 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500">Date</th>
              <th className="px-3 py-2 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500 text-right">n OOS</th>
              <th className="px-3 py-2 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500">Criteria</th>
              <th className="px-3 py-2 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500 text-right">M2 sum</th>
              <th className="px-3 py-2 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500 text-right">M1 sum</th>
              <th className="px-3 py-2 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500 text-right">Lift</th>
              <th className="px-3 py-2 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(renderRow)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
