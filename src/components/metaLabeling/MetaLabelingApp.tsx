/**
 * Meta-labeling research-log dashboard route.
 *
 * Mounted by main.tsx when location.hash matches "#/meta-labeling". Surfaces
 * the N>0 meta-labeling cell-trainings persisted in `quantlab.meta_models`
 * (one row per training; FINAL by `(cell_key, m1_run_sig)`).
 *
 * Design idiom mirrors ClusterApp.tsx: full-bleed dark shell, top header bar
 * with route label + back-to-terminal link, single `main` with one panel.
 *
 * Why a separate route from /#/cluster? Different methodology axis. The
 * cluster dashboard surfaces the older 4-gate framework (DSR/PBO/HLZ/OOS-IS).
 * This route surfaces the meta-labeling 7-criterion verdict framework
 * (sessions 5-7, ADRs 018-025). Composing them onto one screen would conflate
 * two different methodologies — better to keep the per-axis story clean.
 */

import ResearchLogPanel from './ResearchLogPanel';

export default function MetaLabelingApp() {
  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <header className="h-16 border-b border-[#1a1a1a] flex items-center justify-between px-8 bg-black">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-violet-400 animate-pulse shadow-[0_0_10px_rgba(167,139,250,0.5)]" />
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-white italic">
            VECTOR_META · Meta-Labeling Research Log
          </h2>
        </div>
        <div className="flex items-center gap-4">
          <a
            href="#/cluster"
            className="text-[10px] font-black text-cyan-400/80 hover:text-cyan-300 uppercase tracking-[0.2em] border border-cyan-400/30 hover:border-cyan-400 rounded-lg px-3 py-1.5 transition-colors"
          >
            Cluster axis →
          </a>
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
        <ResearchLogPanel />
      </main>
    </div>
  );
}
