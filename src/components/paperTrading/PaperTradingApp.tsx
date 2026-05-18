/**
 * Paper-trading dashboard route.
 *
 * Mounted by main.tsx when location.hash matches "#/paper-trading". Surfaces
 * the live state of the daily-signal daemon: current open positions per
 * deployed cell + recent run history. Read-only.
 *
 * Why this exists: the daemon's primary surfacing was Telegram-only, which
 * is fine for "did anything fire today" but bad for "what are my current
 * positions and how long have I held them." This route fills that gap
 * without changing the daemon.
 *
 * Self-fetches /api/paper-trading/state on mount + refresh button.
 */
import { useEffect, useState, useCallback, type ReactElement } from 'react';
import type {
  PaperTradingResponse,
  CellSummary,
  LongPosition,
  RunHistoryRow,
} from '../../server/paper_trading_dashboard.js';

interface State {
  data: PaperTradingResponse | null;
  loading: boolean;
  error: string | null;
}

const formatPct = (n: number): string => {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
};

const formatPrice = (n: number): string => {
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
};

const formatDateUtc = (iso: string): string => {
  if (!iso) return '—';
  // Accept both "2026-05-06 23:56:32" and ISO; show YYYY-MM-DD HH:MM
  const cleaned = iso.replace('T', ' ').replace('Z', '');
  return cleaned.slice(0, 16);
};

const formatRelativeAge = (iso: string | null): string => {
  if (!iso) return '—';
  const cleaned = iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z');
  const t = Date.parse(cleaned);
  if (!Number.isFinite(t)) return iso;
  const ageMs = Date.now() - t;
  const ageMin = Math.round(ageMs / 60_000);
  if (ageMin < 1) return 'just now';
  if (ageMin < 60) return `${ageMin}m ago`;
  const ageHr = Math.round(ageMin / 60);
  if (ageHr < 48) return `${ageHr}h ago`;
  const ageDay = Math.round(ageHr / 24);
  return `${ageDay}d ago`;
};

const pnlColor = (n: number): string => {
  if (n > 0.5) return 'text-emerald-300';
  if (n < -0.5) return 'text-red-300';
  return 'text-zinc-300';
};

// ─── Header + last-run summary ────────────────────────────────────────────

function HeaderSummary({ data }: { data: PaperTradingResponse }) {
  const totalLong = data.cells.reduce((acc, c) => acc + c.nLong, 0);
  const totalTokens = data.cells.reduce((acc, c) => acc + c.nTotal, 0);
  const cellLabels = data.cells.map(c => c.label).join(', ');
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
      <div className="border border-cyan-400/30 bg-cyan-400/5 rounded p-3">
        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-cyan-400/70 mb-1">
          Last daemon run
        </div>
        <div className="text-sm font-mono text-white">{formatDateUtc(data.lastRunAt ?? '')}</div>
        <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
          {formatRelativeAge(data.lastRunAt)}
        </div>
      </div>
      <div className="border border-cyan-400/30 bg-cyan-400/5 rounded p-3">
        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-cyan-400/70 mb-1">
          Cells tracked
        </div>
        <div className="text-sm font-mono text-white">{data.cells.length}</div>
        <div className="text-[10px] font-mono text-zinc-500 mt-0.5">{cellLabels || '—'}</div>
      </div>
      <div className="border border-cyan-400/30 bg-cyan-400/5 rounded p-3">
        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-cyan-400/70 mb-1">
          Open positions
        </div>
        <div className="text-sm font-mono text-emerald-300">{totalLong}</div>
        <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
          long / {totalTokens} tracked
        </div>
      </div>
      <div className="border border-cyan-400/30 bg-cyan-400/5 rounded p-3">
        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-cyan-400/70 mb-1">
          Run command
        </div>
        <div className="text-[11px] font-mono text-white">npm run daemon:daily</div>
        <div className="text-[10px] font-mono text-zinc-500 mt-0.5">≥ 4:05 pm ET</div>
      </div>
    </div>
  );
}

// ─── Per-cell positions panel ────────────────────────────────────────────

function renderCellPanel(cell: CellSummary): ReactElement {
  const { longPositions } = cell;
  // Sort by unrealized P&L descending (winners on top)
  const sorted = [...longPositions].sort((a, b) => b.unrealizedPct - a.unrealizedPct);
  const totalUnreal = sorted.reduce((acc, p) => acc + p.unrealizedPct, 0);
  const avgUnreal = sorted.length > 0 ? totalUnreal / sorted.length : 0;
  return (
    <div key={cell.cellKey} className="border border-[#1a1a1a] bg-black rounded">
      <div className="border-b border-[#1a1a1a] px-3 py-2 flex items-center justify-between bg-[#0a0a0a]">
        <div className="flex items-center gap-3">
          <div className="text-xs font-black uppercase tracking-[0.2em] text-white">{cell.label}</div>
          <div className="text-[10px] font-mono text-zinc-500">
            {cell.tier} · {cell.interval}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono text-emerald-300">long: {cell.nLong}</span>
          <span className="text-[10px] font-mono text-zinc-500">flat: {cell.nFlat}</span>
          <span className={`text-[10px] font-mono ${pnlColor(avgUnreal)}`}>
            avg unrealized: {formatPct(avgUnreal)}
          </span>
        </div>
      </div>
      {sorted.length === 0 ? (
        <div className="px-4 py-6 text-center text-[11px] font-mono text-zinc-500">
          No open positions in this cell. {cell.nFlat} tokens tracked, all flat.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-[#0a0a0a] border-b border-[#1a1a1a]">
              <tr className="text-left text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500">
                <th className="px-2 py-1.5">Symbol</th>
                <th className="px-2 py-1.5">Entry (UTC)</th>
                <th className="px-2 py-1.5 text-right">Entry $</th>
                <th className="px-2 py-1.5 text-right">Latest $</th>
                <th className="px-2 py-1.5 text-right">Unrealized</th>
                <th className="px-2 py-1.5 text-right">Bars held</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(pos => (
                <tr key={pos.tokenAddress} className="border-b border-[#1a1a1a] hover:bg-cyan-400/5">
                  <td className="px-2 py-1.5 font-mono text-white text-xs">{pos.symbol}</td>
                  <td className="px-2 py-1.5 font-mono text-zinc-400 text-[10px]">
                    {formatDateUtc(pos.positionEntryTs)}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-zinc-300 text-xs text-right">
                    ${formatPrice(pos.positionEntryPrice)}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-zinc-300 text-xs text-right">
                    ${formatPrice(pos.latestClose)}
                  </td>
                  <td className={`px-2 py-1.5 font-mono text-xs text-right font-black ${pnlColor(pos.unrealizedPct)}`}>
                    {formatPct(pos.unrealizedPct)}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-zinc-400 text-xs text-right">
                    {pos.barsHeld}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Run history timeline ────────────────────────────────────────────────

function RunHistoryPanel({ runs }: { runs: RunHistoryRow[] }) {
  // Group by run_id (one UUID per daemon invocation, consistent across cells).
  // Grouping by run_at would split a single invocation into multiple rows
  // because the daemon's per-cell inserts call now() sequentially and land
  // at slightly different second values.
  const byRun = new Map<string, { runAt: string; perCell: Map<string, RunHistoryRow> }>();
  for (const r of runs) {
    if (!byRun.has(r.runId)) byRun.set(r.runId, { runAt: r.runAt, perCell: new Map() });
    const entry = byRun.get(r.runId)!;
    entry.perCell.set(r.cellKey, r);
    // Track latest run_at across all cells for this run_id (display purposes).
    if (r.runAt > entry.runAt) entry.runAt = r.runAt;
  }
  const cellKeys = Array.from(new Set(runs.map(r => r.cellKey))).sort();
  const runIds = Array.from(byRun.keys()).sort((a, b) => byRun.get(b)!.runAt.localeCompare(byRun.get(a)!.runAt));
  if (runIds.length === 0) {
    return (
      <div className="border border-[#1a1a1a] bg-black rounded p-4 text-center text-[11px] font-mono text-zinc-500">
        No run history yet.
      </div>
    );
  }
  return (
    <div className="border border-[#1a1a1a] bg-black rounded">
      <div className="border-b border-[#1a1a1a] px-3 py-2 bg-[#0a0a0a]">
        <div className="text-xs font-black uppercase tracking-[0.2em] text-white">
          Recent daemon runs
        </div>
        <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
          One row per run; columns show long/total per cell. ReplacingMergeTree may reap older rows on background merge.
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-[#0a0a0a] border-b border-[#1a1a1a]">
            <tr className="text-left text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500">
              <th className="px-2 py-1.5">Run (UTC)</th>
              {cellKeys.map(k => {
                const parts = k.split('|');
                const display = parts.length === 4
                  ? (parts[0] === 'mean_reversion_v1' ? 'mr_v1' : parts[0]) + '/p=' + parts[3]
                  : k;
                return (
                  <th key={k} className="px-2 py-1.5 text-right">{display}</th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {runIds.map(runId => {
              const entry = byRun.get(runId)!;
              return (
                <tr key={runId} className="border-b border-[#1a1a1a] hover:bg-cyan-400/5">
                  <td className="px-2 py-1.5 font-mono text-zinc-400 text-[10px]">
                    {formatDateUtc(entry.runAt)}
                  </td>
                  {cellKeys.map(k => {
                    const cellRow = entry.perCell.get(k);
                    if (!cellRow) {
                      return <td key={k} className="px-2 py-1.5 font-mono text-zinc-700 text-xs text-right">—</td>;
                    }
                    return (
                      <td key={k} className="px-2 py-1.5 font-mono text-xs text-right">
                        <span className="text-emerald-300">{cellRow.nLong}</span>
                        <span className="text-zinc-600">/</span>
                        <span className="text-zinc-400">{cellRow.nLong + cellRow.nFlat}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main app ────────────────────────────────────────────────────────────

export default function PaperTradingApp() {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });

  const refresh = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const r = await fetch('/api/paper-trading/state');
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`${r.status}: ${text.slice(0, 200)}`);
      }
      const data = await r.json() as PaperTradingResponse;
      setState({ data, loading: false, error: null });
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <header className="h-16 border-b border-[#1a1a1a] flex items-center justify-between px-8 bg-black">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_10px_rgba(52,211,153,0.5)]" />
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-white italic">
            VECTOR_PAPER · Daily-Signal Daemon
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={state.loading}
            className="text-[10px] font-black text-emerald-400/80 hover:text-emerald-300 uppercase tracking-[0.2em] border border-emerald-400/30 hover:border-emerald-400 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
          >
            {state.loading ? 'loading…' : '↻ refresh'}
          </button>
          <a
            href="#/cluster"
            className="text-[10px] font-black text-cyan-400/80 hover:text-cyan-300 uppercase tracking-[0.2em] border border-cyan-400/30 hover:border-cyan-400 rounded-lg px-3 py-1.5 transition-colors"
          >
            Cluster axis →
          </a>
          <a
            href="#/meta-labeling"
            className="text-[10px] font-black text-violet-400/80 hover:text-violet-300 uppercase tracking-[0.2em] border border-violet-400/30 hover:border-violet-400 rounded-lg px-3 py-1.5 transition-colors"
          >
            Meta-labeling →
          </a>
          <a
            href="#/"
            className="text-[10px] font-black text-cyan-400/80 hover:text-cyan-300 uppercase tracking-[0.2em] border border-cyan-400/30 hover:border-cyan-400 rounded-lg px-3 py-1.5 transition-colors"
          >
            ← Terminal
          </a>
        </div>
      </header>
      <main className="p-6 space-y-4 max-w-[1400px] mx-auto">
        {state.error && (
          <div className="border border-red-500/40 bg-red-500/10 rounded p-3 text-[11px] font-mono text-red-300">
            <div className="font-black uppercase tracking-[0.2em] mb-1">Failed to load</div>
            <div>{state.error}</div>
            <div className="mt-2 text-[10px] text-red-300/70">
              Common causes: ClickHouse unreachable; <code>quantlab.live_signals</code> table missing
              (run <code>npm run migrate:live-signals -- --apply</code>); daemon never run yet.
            </div>
          </div>
        )}
        {!state.error && state.loading && !state.data && (
          <div className="border border-[#1a1a1a] bg-black rounded p-6 text-center text-[11px] font-mono text-zinc-500">
            Loading paper-trading state…
          </div>
        )}
        {state.data && (
          <>
            <HeaderSummary data={state.data} />
            {state.data.cells.length === 0 ? (
              <div className="border border-yellow-500/40 bg-yellow-500/10 rounded p-4 text-center text-[11px] font-mono text-yellow-300">
                <div className="font-black uppercase tracking-[0.2em] mb-1">No daemon runs yet</div>
                <div>
                  Run <code className="text-white">npm run daemon:daily</code> after market close
                  (≥ 4:05 pm ET) to populate <code>quantlab.live_signals</code> for the first time.
                </div>
              </div>
            ) : (
              <>
                {state.data.cells.map(renderCellPanel)}
                <RunHistoryPanel runs={state.data.runHistory} />
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
