/**
 * Cluster-axis dashboard route — Phase 2 §5.5.
 *
 * Mounted by main.tsx when location.hash matches "#/cluster". Layout idiom
 * mirrors ValidatorApp.tsx: full-bleed dark shell, top header bar with route
 * label + back-to-terminal link, single `main` with two stacked panels.
 *
 * The panels do NOT share state — each self-fetches its own data on mount.
 * That's a deliberate simplification (see SPEC §3.4 race note): if Panel A
 * re-fetches and pulls a different fitId than Panel B, they could disagree.
 * Acceptable for v1 because neither panel has refresh affordances; both fetch
 * once on mount.
 */

import ClusterDiagnosticsPanel from './ClusterDiagnosticsPanel';
import ClusterScoresPanel from './ClusterScoresPanel';

export default function ClusterApp() {
  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <header className="h-16 border-b border-[#1a1a1a] flex items-center justify-between px-8 bg-black">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_10px_rgba(34,211,238,0.5)]" />
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-white italic">
            VECTOR_CLUSTER · Behavioral Universe
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
            className="text-[10px] font-black text-cyan-400/80 hover:text-cyan-300 uppercase tracking-[0.2em] border border-cyan-400/30 hover:border-cyan-400 rounded-lg px-3 py-1.5 transition-colors"
          >
            ← Terminal
          </a>
        </div>
      </header>
      <main className="p-6 space-y-6">
        <ClusterDiagnosticsPanel />
        <ClusterScoresPanel />
      </main>
    </div>
  );
}
