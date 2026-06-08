/**
 * TodayApp — the answer-first command-center landing page (/#/today, new default route).
 *
 * The synthesis layer over the 16 dense composite panels: one-line verdict → plain-language
 * drivers → the 5 numbers that matter (each translated) → FTEC focus + movers → what-changed →
 * attention → grouped drill-downs. Reads GET /api/today (src/server/today_dashboard.ts).
 * DECISION-SUPPORT ONLY — describes state, never buy/sell (ADR-056).
 */
import { useEffect, useState, type ReactNode } from 'react';

type Tone = 'good' | 'warn' | 'bad' | 'neutral';
interface TodayNumber { label: string; value: string; tone: Tone; meaning: string; href?: string }
interface TodayMover { ticker: string; weight: number; dayPct: number | null; price: number | null }
interface TodayPayload {
  asOf: string; hasData: boolean;
  verdict: { tone: Tone; headline: string };
  drivers: string[];
  numbers: TodayNumber[];
  ftec: { price: number | null; dayPct: number | null; asOf: string | null; movers: TodayMover[] };
  whatChanged: string[];
  attention: { level: 'info' | 'warn'; text: string }[];
  drilldowns: { group: string; links: { label: string; href: string }[] }[];
}

const TONE_TEXT: Record<Tone, string> = { good: 'text-emerald-400', warn: 'text-amber-400', bad: 'text-rose-400', neutral: 'text-zinc-300' };
const TONE_BORDER: Record<Tone, string> = { good: 'border-emerald-500/40', warn: 'border-amber-500/40', bad: 'border-rose-500/40', neutral: 'border-zinc-700' };
const TONE_BG: Record<Tone, string> = { good: 'bg-emerald-500/[0.06]', warn: 'bg-amber-500/[0.06]', bad: 'bg-rose-500/[0.06]', neutral: 'bg-zinc-800/20' };
const TONE_DOT: Record<Tone, string> = { good: 'bg-emerald-400', warn: 'bg-amber-400', bad: 'bg-rose-400', neutral: 'bg-zinc-400' };

function pctColor(p: number | null): string {
  if (p == null) return 'text-zinc-500';
  return p > 0 ? 'text-emerald-400' : p < -1.5 ? 'text-rose-400' : p < 0 ? 'text-amber-400' : 'text-zinc-300';
}
const fmtPct = (p: number | null) => (p == null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`);

function Shell({ children, asOf }: { children: ReactNode; asOf?: string }) {
  return (
    <div className="min-h-screen bg-[#050505] text-zinc-200">
      <header className="h-14 border-b border-[#1a1a1a] flex items-center justify-between px-6 bg-black sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse shadow-[0_0_10px_rgba(250,204,21,0.5)]" />
          <h1 className="text-xs font-black uppercase tracking-[0.3em] text-white italic">SIGNALFORGE · TODAY</h1>
        </div>
        <div className="flex items-center gap-4">
          {asOf && <span className="text-[9px] font-mono text-zinc-600">as of {new Date(asOf).toLocaleString()}</span>}
          <a href="#/terminal" className="text-[9px] font-black text-zinc-400 hover:text-white uppercase tracking-[0.2em] border border-zinc-700 hover:border-zinc-400 rounded px-3 py-1.5 transition-colors">Full terminal →</a>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-6 py-6">{children}</main>
    </div>
  );
}

export default function TodayApp() {
  const [data, setData] = useState<TodayPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/today')
      .then(r => (r.ok ? r.json() : r.json().then((j: any) => Promise.reject(j.detail || `HTTP ${r.status}`))))
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, []);

  if (err) return (
    <Shell>
      <div className="border border-rose-500/40 bg-rose-500/5 rounded-lg p-4 text-xs font-mono text-rose-300">
        Couldn't load Today: {err}. Is ClickHouse up? Check the <a className="underline hover:text-white" href="#/health">health page</a>.
      </div>
    </Shell>
  );
  if (!data) return <Shell><div className="text-zinc-600 text-[10px] font-mono uppercase tracking-widest py-20 text-center">loading today…</div></Shell>;
  if (!data.hasData) return (
    <Shell asOf={data.asOf}>
      <div className="border border-zinc-700 bg-zinc-800/20 rounded-lg p-6 text-center text-zinc-400 text-sm">
        Awaiting first data load — no composite snapshots yet. Run the daily refresh, then reload.
      </div>
    </Shell>
  );

  const v = data.verdict;
  return (
    <Shell asOf={data.asOf}>
      {/* ── VERDICT (the answer, first) ────────────────────────────────── */}
      <section className={`rounded-xl border ${TONE_BORDER[v.tone]} ${TONE_BG[v.tone]} p-5 mb-6`}>
        <div className="flex items-center gap-2 mb-2">
          <span className={`w-2.5 h-2.5 rounded-full ${TONE_DOT[v.tone]} animate-pulse`} />
          <span className="text-[10px] font-black uppercase tracking-[0.25em] text-zinc-500">Bottom line</span>
        </div>
        <p className={`text-lg md:text-xl font-bold leading-snug ${TONE_TEXT[v.tone]}`}>{v.headline}</p>
        <ul className="mt-3 space-y-1">
          {data.drivers.map((d, i) => (
            <li key={i} className="text-[13px] text-zinc-300 flex gap-2"><span className="text-zinc-600">›</span>{d}</li>
          ))}
        </ul>
      </section>

      {/* ── THE NUMBERS THAT MATTER ────────────────────────────────────── */}
      <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-zinc-500 mb-2">The numbers that matter</h2>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        {data.numbers.map((n, i) => (
          <a key={i} href={n.href || '#'} className={`block rounded-lg border ${TONE_BORDER[n.tone]} ${TONE_BG[n.tone]} p-3 hover:brightness-125 transition`}>
            <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">{n.label}</div>
            <div className={`text-2xl font-black tabular-nums ${TONE_TEXT[n.tone]}`}>{n.value}</div>
            <div className="text-[11px] text-zinc-400 leading-tight mt-1">{n.meaning}</div>
          </a>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-6 mb-6">
        {/* ── FTEC FOCUS ───────────────────────────────────────────────── */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-zinc-500">FTEC focus</h2>
            <a href="#/single-stock?ticker=FTEC" className="text-[9px] text-zinc-500 hover:text-white">drill down →</a>
          </div>
          <div className="flex items-baseline gap-3 mb-3">
            <span className="text-3xl font-black tabular-nums text-white">{data.ftec.price != null ? `$${data.ftec.price.toFixed(2)}` : '—'}</span>
            <span className={`text-sm font-bold tabular-nums ${pctColor(data.ftec.dayPct)}`}>{fmtPct(data.ftec.dayPct)}</span>
          </div>
          <table className="w-full text-[12px]">
            <thead><tr className="text-zinc-600 text-[9px] uppercase tracking-wider"><th className="text-left font-semibold">Holding</th><th className="text-right font-semibold">Wt</th><th className="text-right font-semibold">Today</th><th className="text-right font-semibold">Price</th></tr></thead>
            <tbody>
              {data.ftec.movers.map(m => (
                <tr key={m.ticker} className="border-t border-zinc-800/60">
                  <td className="py-1 font-bold text-zinc-200">{m.ticker}</td>
                  <td className="py-1 text-right tabular-nums text-zinc-500">{m.weight.toFixed(1)}%</td>
                  <td className={`py-1 text-right tabular-nums font-semibold ${pctColor(m.dayPct)}`}>{fmtPct(m.dayPct)}</td>
                  <td className="py-1 text-right tabular-nums text-zinc-400">{m.price != null ? `$${m.price.toFixed(2)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* ── WHAT CHANGED + ATTENTION ─────────────────────────────────── */}
        <div className="space-y-6">
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-zinc-500 mb-2">What changed</h2>
            <ul className="space-y-1">
              {data.whatChanged.map((c, i) => <li key={i} className="text-[13px] text-zinc-300 flex gap-2"><span className="text-zinc-600">Δ</span>{c}</li>)}
            </ul>
          </section>
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-zinc-500 mb-2">Needs your attention</h2>
            <ul className="space-y-1">
              {data.attention.map((a, i) => (
                <li key={i} className="text-[13px] flex gap-2">
                  <span className={a.level === 'warn' ? 'text-amber-400' : 'text-emerald-500'}>{a.level === 'warn' ? '!' : '✓'}</span>
                  <span className={a.level === 'warn' ? 'text-amber-200' : 'text-zinc-400'}>{a.text}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      {/* ── DRILL-DOWNS (the 16 panels, grouped) ──────────────────────── */}
      <h2 className="text-[10px] font-black uppercase tracking-[0.25em] text-zinc-500 mb-2">Drill down</h2>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-8">
        {data.drilldowns.map(g => (
          <div key={g.group} className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
            <div className="text-[9px] font-black uppercase tracking-wider text-zinc-500 mb-2">{g.group}</div>
            <div className="flex flex-wrap gap-1.5">
              {g.links.map(l => (
                <a key={l.href} href={l.href} className="text-[11px] text-zinc-300 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded px-2 py-0.5 transition-colors">{l.label}</a>
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className="text-[10px] text-zinc-600 text-center pb-6">Decision-support only — describes market state, not investment advice. Numbers trace to SignalForge composites + live prices (ADR-056).</p>
    </Shell>
  );
}
