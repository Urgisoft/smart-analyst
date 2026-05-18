/**
 * Bias-quarantine banner — ADR-037 §5 operator-facing surface.
 *
 * Renders at the top of the regime route, larger than the regime label
 * itself. The fact that `phase1_v2` ships under documented survivorship bias
 * is the first thing the operator sees — anything less risks silent trust
 * in a biased label.
 *
 * SPEC: docs/specs/regime-dashboard-component3.md §3.3 (Panel A).
 */
import type { BiasNote } from '../../../server/regime_dashboard.js';

export function BiasBanner({ note, classifierVersion }: { note: BiasNote; classifierVersion: string }) {
  return (
    <div className="border border-amber-400/50 bg-amber-500/10 rounded p-4 mb-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[9px] font-black uppercase tracking-[0.25em] text-amber-300/80">
              Bias quarantine · ADR-037
            </span>
            <span className="text-[10px] font-mono text-amber-200/60">
              classifier_version=<span className="text-amber-100">{classifierVersion}</span>
            </span>
          </div>
          <div className="text-sm font-black text-amber-100 mb-1.5">{note.headline}</div>
          <div className="text-[11px] font-mono text-amber-100/80 leading-relaxed max-w-4xl">
            {note.body}
          </div>
          <div className="text-[10px] font-mono text-amber-200/70 mt-2">
            <span className="text-amber-100">{note.fixtureFailures}</span>
            <span> fixture test{note.fixtureFailures === 1 ? '' : 's'} intentionally failing under {classifierVersion} — see ADR-037 §5.</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 shrink-0">
          {note.docLinks.map(link => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] font-mono uppercase tracking-[0.15em] text-amber-200 hover:text-amber-100 border border-amber-400/30 hover:border-amber-400/60 rounded px-2 py-1 transition-colors"
            >
              {link.label} →
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
