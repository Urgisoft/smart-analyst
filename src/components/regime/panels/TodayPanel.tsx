/**
 * Today's regime + indicator strip — Panel B.
 *
 * Left half: large regime color block with label, days-in-regime counter,
 * previous-regime badge, and the asOfDate / isLatest provenance.
 * Right half: 4 indicator cells. Each shows raw values, threshold context,
 * and a fired/not-fired pill derived from the row (NOT recomputed in UI).
 *
 * SPEC: docs/specs/regime-dashboard-component3.md §3.3 (Panel B).
 *
 * Tailwind class maps are static (no `bg-${regime}-...` interpolation) so
 * the JIT purge keeps every variant in the production CSS.
 */
import type { MacroRegimeRow, Regime } from '../../../server/macro_regime.js';

const REGIME_BG: Record<Regime, string> = {
  green:  'bg-emerald-500/20 border-emerald-400/60',
  yellow: 'bg-yellow-500/25 border-yellow-400/60',
  orange: 'bg-orange-500/25 border-orange-400/70',
  red:    'bg-red-500/30 border-red-400/70',
};

const REGIME_TEXT: Record<Regime, string> = {
  green:  'text-emerald-200',
  yellow: 'text-yellow-200',
  orange: 'text-orange-200',
  red:    'text-red-200',
};

const REGIME_LABEL: Record<Regime, string> = {
  green:  'GREEN — risk-on',
  yellow: 'YELLOW — caution',
  orange: 'ORANGE — defensive',
  red:    'RED — risk-off',
};

function pctFmt(x: number | null, digits = 2): string {
  if (x == null || !Number.isFinite(x)) return '—';
  const sign = x >= 0 ? '+' : '';
  return `${sign}${(x * 100).toFixed(digits)}%`;
}

function numFmt(x: number | null, digits = 3): string {
  if (x == null || !Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}

function FirePill({ on, label, dark }: { on: 0 | 1; label: string; dark?: boolean }) {
  if (dark) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-mono uppercase tracking-[0.15em] border border-zinc-700 bg-zinc-900/50 text-zinc-500">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
        {label} · dark
      </span>
    );
  }
  return on === 1 ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-mono uppercase tracking-[0.15em] border border-red-400/50 bg-red-500/15 text-red-200">
      <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
      {label} · firing
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-mono uppercase tracking-[0.15em] border border-zinc-700 bg-zinc-900/30 text-zinc-500">
      <span className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
      {label} · clear
    </span>
  );
}

function IndicatorCell({
  title, primary, secondary, threshold, fire, dark, footer,
}: {
  title: string;
  primary: string;
  secondary?: string;
  threshold: string;
  fire: 0 | 1;
  dark?: boolean;
  footer?: string;
}) {
  return (
    <div className="border border-[#1a1a1a] bg-black rounded p-3 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">{title}</span>
        <FirePill on={fire} label={title.split(' ')[0]} dark={dark} />
      </div>
      <div className="text-base font-mono text-white">{primary}</div>
      {secondary && (
        <div className="text-[10px] font-mono text-zinc-500">{secondary}</div>
      )}
      <div className="text-[9px] font-mono text-zinc-600">threshold: {threshold}</div>
      {footer && (
        <div className="text-[9px] font-mono text-zinc-600 italic">{footer}</div>
      )}
    </div>
  );
}

export function TodayPanel({
  today, daysInCurrentRegime, previousRegime, asOfDate, isLatest,
}: {
  today: MacroRegimeRow;
  daysInCurrentRegime: number;
  previousRegime: { regime: Regime; lastDate: string } | null;
  asOfDate: string;
  isLatest: boolean;
}) {
  const regime = today.regime;
  const dayWord = daysInCurrentRegime === 1 ? 'day' : 'days';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-3">
      {/* Left — color block */}
      <div className={`border-2 rounded p-5 flex flex-col justify-between ${REGIME_BG[regime]}`}>
        <div>
          <div className="text-[9px] font-black uppercase tracking-[0.25em] text-white/60 mb-2">
            Current regime
          </div>
          <div className={`text-3xl lg:text-4xl font-black ${REGIME_TEXT[regime]} mb-1`}>
            {REGIME_LABEL[regime]}
          </div>
          <div className={`text-[11px] font-mono ${REGIME_TEXT[regime]}/80 mb-3`}>
            {daysInCurrentRegime} {dayWord} in regime
            {previousRegime && (
              <span className="text-white/40">
                {' '}· prev <span className={REGIME_TEXT[previousRegime.regime]}>{previousRegime.regime}</span>{' '}
                ended {previousRegime.lastDate}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between text-[10px] font-mono text-white/50 mt-2 pt-2 border-t border-white/10">
          <span>asOf {asOfDate}</span>
          <span>{isLatest ? '· live' : '· clamped'}</span>
        </div>
      </div>

      {/* Right — 4 indicator cells */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <IndicatorCell
          title="VIX TERM"
          primary={numFmt(today.vix_term_ratio, 3)}
          secondary={`vix=${numFmt(today.vix_close, 2)} / vix3m=${numFmt(today.vix3m_close, 2)}`}
          threshold="ratio > 1.000"
          fire={today.vix_term_inverted}
        />
        <IndicatorCell
          title="CREDIT DIV"
          primary={`HYG ${pctFmt(today.hyg_20d_return)} · SPY ${pctFmt(today.spy_20d_return)}`}
          secondary={`10d audit · HYG ${pctFmt(today.hyg_10d_return)} · SPY ${pctFmt(today.spy_10d_return)}`}
          threshold="HYG<0 AND SPY>0 over 20d"
          fire={today.hyg_spy_divergence}
        />
        <IndicatorCell
          title="BREADTH"
          primary={today.pct_above_50dma == null ? '—' : `${today.pct_above_50dma.toFixed(1)}%`}
          secondary={`source: ${today.pct_above_50dma_source || '—'}`}
          threshold="< 50% AND SPY ≥ 95% × 1Y high"
          fire={today.breadth_narrow}
          footer={today.pct_above_50dma_source === '' ? 'no breadth row — fallback dark' : undefined}
        />
        <IndicatorCell
          title="REALIZED STRESS"
          primary={today.spy_drawdown_from_1y_high == null ? '—' : pctFmt(today.spy_drawdown_from_1y_high, 2)}
          secondary={`spy=${numFmt(today.spy_close, 2)} / 1Y-high=${numFmt(today.spy_252d_high, 2)}`}
          threshold="θ=null per Phase 2 SPEC §1.1"
          fire={today.realized_stress}
          dark={true}
          footer="activates at phase2_v1"
        />
      </div>
    </div>
  );
}
