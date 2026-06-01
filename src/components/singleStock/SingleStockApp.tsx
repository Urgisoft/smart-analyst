/**
 * Single-stock detail dashboard — first UI of the post-validation phase.
 *
 * Mounted by main.tsx when location.hash matches "#/single-stock". A ticker
 * input box + a Bloomberg-density decision-support readout assembled from
 * /api/single-stock/:ticker. The options dimension is prominent (IV term
 * structure, put/call vol+OI, skew), then technicals, positioning, macro-fit,
 * fundamentals.
 *
 * NO ALPHA CLAIM. ADR-056 concluded the comprehensive validation null —
 * nothing here is a validated signal. The header labels this explicitly:
 * "Decision-support — not a validated signal (ADR-056)." Empty/error states
 * are honest ("unavailable" / "awaiting", never NaN%/Infinity).
 *
 * Self-fetches on submit. Deep-linkable via `#/single-stock?ticker=NVDA` —
 * the symbol is read from the hash query string on mount.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  SingleStockScorecard,
  OptionsBlock,
  FundamentalsBlock,
} from '../../server/single_stock_dashboard.js';
import type {
  TechnicalsBlock,
  PositioningBlock,
  MacroFitBlock,
} from '../../server/single_stock_repository.js';

interface State {
  ticker: string;
  data: SingleStockScorecard | null;
  loading: boolean;
  error: string | null;
}

function tickerFromHash(): string {
  const q = window.location.hash.split('?')[1] ?? '';
  const m = new URLSearchParams(q).get('ticker');
  return (m ?? '').toUpperCase();
}

export default function SingleStockApp() {
  const initial = tickerFromHash();
  const [state, setState] = useState<State>({
    ticker: initial, data: null, loading: false, error: null,
  });

  const run = useCallback(async (rawTicker: string) => {
    const ticker = rawTicker.trim().toUpperCase();
    if (!ticker) {
      setState(s => ({ ...s, error: 'Enter a ticker (e.g. NVDA).' }));
      return;
    }
    setState(s => ({ ...s, ticker, loading: true, error: null }));
    try {
      const r = await fetch(`/api/single-stock/${encodeURIComponent(ticker)}`);
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
      const data = await r.json() as SingleStockScorecard;
      setState({ ticker, data, loading: false, error: null });
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  // Auto-run if a ticker was deep-linked.
  useEffect(() => { if (initial) run(initial); }, [initial, run]);

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <header className="h-16 border-b border-[#1a1a1a] flex items-center justify-between px-8 bg-black sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-[0_0_10px_rgba(251,191,36,0.5)]" />
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-white italic">
            VECTOR_TERMINAL · Single-Stock Readout
          </h2>
          <span className="text-[10px] font-mono text-amber-300/80 ml-2 border border-amber-400/40 rounded px-2 py-0.5">
            Decision-support — not a validated signal (ADR-056)
          </span>
        </div>
        <div className="flex items-center gap-3">
          <form
            onSubmit={(e) => { e.preventDefault(); run(state.ticker); }}
            className="flex items-center gap-1"
          >
            <input
              value={state.ticker}
              onChange={(e) => setState(s => ({ ...s, ticker: e.target.value.toUpperCase() }))}
              placeholder="TICKER"
              maxLength={6}
              className="w-28 bg-[#0a0a0a] border border-zinc-700 focus:border-amber-400/60 rounded px-3 py-1 text-[12px] font-mono uppercase tracking-widest text-amber-200 outline-none"
            />
            <button
              type="submit"
              disabled={state.loading}
              className="text-[10px] font-mono uppercase tracking-[0.2em] text-amber-300 hover:text-amber-100 border border-amber-400/30 hover:border-amber-400/60 rounded px-3 py-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {state.loading ? 'loading…' : 'load'}
            </button>
          </form>
          <a
            href="/"
            className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500 hover:text-white transition-colors"
          >
            ← back
          </a>
        </div>
      </header>

      <main className="p-6 max-w-[1600px] mx-auto">
        <DisclaimerBanner />

        {state.error && (
          <div className="border border-red-500/40 bg-red-500/10 rounded p-4 mb-4">
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-red-300 mb-1">
              Failed to load scorecard for {state.ticker || '(none)'}
            </div>
            <div className="text-[11px] font-mono text-red-200/80">{state.error}</div>
            <div className="text-[10px] font-mono text-zinc-500 mt-2">
              If this says clickhouse_unavailable, the CH container is down — start Docker
              Desktop + <code className="text-amber-200">docker start quantlab-clickhouse</code>.
            </div>
          </div>
        )}

        {state.loading && !state.data && (
          <div className="text-[11px] font-mono text-zinc-500">assembling scorecard…</div>
        )}

        {!state.data && !state.loading && !state.error && <EmptyPrompt onPick={run} />}

        {state.data && <Scorecard data={state.data} />}
      </main>
    </div>
  );
}

// ── Banners + prompts ────────────────────────────────────────────────────────

function DisclaimerBanner() {
  return (
    <div className="border border-amber-500/30 bg-amber-500/5 rounded p-3 mb-4 flex items-start gap-3">
      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-300 whitespace-nowrap pt-0.5">
        Decision-support
      </div>
      <div className="text-[11px] font-mono text-amber-100/80 leading-relaxed">
        This is a <span className="text-amber-300 font-bold">data-aggregation terminal</span>, not a
        signal. Per <code className="text-amber-300">ADR-056</code> the system's validation came back
        comprehensively <span className="text-amber-300 font-bold">null</span> — nothing here ranks,
        scores-to-buy, or recommends a trade. Every number traces to a free source (Polygon, yfinance,
        SEC EDGAR, FINRA, FRED). Read it; decide for yourself.
      </div>
    </div>
  );
}

function EmptyPrompt({ onPick }: { onPick: (t: string) => void }) {
  const examples = ['NVDA', 'AAPL', 'MSFT', 'TSLA', 'AMD'];
  return (
    <div className="border border-zinc-800 bg-black rounded p-8 text-center">
      <div className="text-[11px] font-mono text-zinc-400 mb-3">
        Enter a US-equity ticker above to assemble its scorecard.
      </div>
      <div className="flex items-center justify-center gap-2">
        {examples.map(t => (
          <button
            key={t}
            onClick={() => onPick(t)}
            className="text-[11px] font-mono text-amber-300 hover:text-amber-100 border border-amber-400/30 hover:border-amber-400/60 rounded px-3 py-1 transition-colors"
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Scorecard layout ─────────────────────────────────────────────────────────

function Scorecard({ data }: { data: SingleStockScorecard }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <div className="text-4xl font-black text-white tracking-tight">{data.ticker}</div>
        <div className="text-[10px] font-mono text-zinc-500">
          generated {data.generatedAt.slice(0, 19).replace('T', ' ')}Z
        </div>
      </div>
      {/* Options is the headline dimension — full width, first. */}
      <OptionsPanel options={data.options} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TechnicalsPanel t={data.technicals} />
        <PositioningPanel p={data.positioning} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MacroFitPanel m={data.macroFit} />
        <FundamentalsPanel f={data.fundamentals} />
      </div>
    </div>
  );
}

// ── Options panel (prominent) ──────────────────────────────────────────────────

function OptionsPanel({ options }: { options: OptionsBlock }) {
  if (!options.available) {
    return (
      <PanelShell title="Options (forward-looking)" accent="violet">
        <Unavailable note={options.note ?? 'options unavailable'} />
      </PanelShell>
    );
  }
  const flag = options.termStructureFlag ?? 'insufficient';
  const flagColor =
    flag === 'backwardation' ? 'text-orange-300'
      : flag === 'contango' ? 'text-cyan-300'
        : 'text-zinc-400';
  const ne = options.nearestExpiry;
  const sk = options.skew;
  return (
    <PanelShell
      title="Options (forward-looking)"
      accent="violet"
      subtitle={`spot ${fmtNum(options.spot, 2)} · ${options.numExpirations ?? 0} expirations · yfinance live chain @ ${options.asOf?.slice(0, 19).replace('T', ' ') ?? 'n/a'}Z`}
    >
      {(options.ivRepaired ?? 0) > 0 && (
        <div className="text-[10px] font-mono text-amber-300/80 mb-2 leading-snug">
          ⚠ {options.ivRepaired} contracts' IV solved from price (Yahoo IV unavailable — likely
          pre/post-market). Volatilities are model-derived from last trade, not live quotes.
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr_1fr] gap-4">
        {/* IV term structure mini-table */}
        <div>
          <SubLabel>IV term structure (ATM)</SubLabel>
          <div className="text-[10px] font-mono text-zinc-300">
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-zinc-500 border-b border-zinc-800 pb-1 mb-1">
              <span>expiry</span><span className="text-right">dte</span><span className="text-right">ATM IV</span>
            </div>
            {options.termStructure.slice(0, 8).map(p => (
              <div key={p.date} className="grid grid-cols-[1fr_auto_auto] gap-x-3 leading-relaxed">
                <span>{p.date}</span>
                <span className="text-right text-zinc-500">{p.dte}</span>
                <span className="text-right">{fmtPct(p.atmIv)}</span>
              </div>
            ))}
          </div>
          <div className="text-[11px] font-mono mt-2 pt-2 border-t border-zinc-800">
            near {fmtPct(options.nearAtmIv)} · far {fmtPct(options.farAtmIv)} ·{' '}
            <span className={`font-bold ${flagColor}`}>{flag.toUpperCase()}</span>
          </div>
          <div className="text-[9px] font-mono text-zinc-600 mt-1 leading-snug">
            {flag === 'backwardation'
              ? 'near-term IV richer — often a known near catalyst / earnings.'
              : flag === 'contango'
                ? 'longer-dated IV richer — the common calm-market shape.'
                : 'term structure flat / insufficient.'}
          </div>
        </div>

        {/* Put/Call ratios */}
        <div>
          <SubLabel>Put / Call ratios</SubLabel>
          <Row label="all expiries · vol" value={fmtRatio(options.pcVolumeAll)} hint={biasHint(options.pcVolumeAll)} />
          <Row label="all expiries · OI" value={fmtRatio(options.pcOiAll)} hint={biasHint(options.pcOiAll)} />
          {ne && (
            <>
              <Row label={`nearest · vol`} value={fmtRatio(ne.pcVolume)} hint={biasHint(ne.pcVolume)} />
              <Row label={`nearest · OI`} value={fmtRatio(ne.pcOi)} hint={biasHint(ne.pcOi)} />
            </>
          )}
          <div className="text-[9px] font-mono text-zinc-600 mt-2 leading-snug">
            &gt;1 put-heavy (hedged / bearish) · &lt;1 call-heavy (speculative / bullish).
          </div>
        </div>

        {/* Skew + nearest totals */}
        <div>
          <SubLabel>Skew + nearest expiry</SubLabel>
          {sk ? (
            <>
              <Row label={`OTM put (±${Math.round((sk.pctOffset ?? 0) * 100)}%)`} value={`${fmtNum(sk.putStrike, 2)} @ ${fmtPct(sk.putIv)}`} />
              <Row label={`OTM call (±${Math.round((sk.pctOffset ?? 0) * 100)}%)`} value={`${fmtNum(sk.callStrike, 2)} @ ${fmtPct(sk.callIv)}`} />
              <Row
                label="put−call IV skew"
                value={sk.skewPts == null ? 'n/a' : `${sk.skewPts >= 0 ? '+' : ''}${sk.skewPts.toFixed(2)} pts`}
                hint={sk.skewPts == null ? '' : sk.skewPts > 0 ? 'downside fear (normal)' : 'call skew (unusual)'}
              />
            </>
          ) : <div className="text-[10px] font-mono text-zinc-600">skew n/a</div>}
          {ne && (
            <div className="text-[9px] font-mono text-zinc-500 mt-2 pt-2 border-t border-zinc-800 leading-relaxed">
              {ne.date} (dte {ne.dte})<br />
              call vol {fmtInt(ne.callVolume)} · put vol {fmtInt(ne.putVolume)}<br />
              call OI {fmtInt(ne.callOi)} · put OI {fmtInt(ne.putOi)}
            </div>
          )}
        </div>
      </div>
      <div className="text-[9px] font-mono text-zinc-600 mt-3 pt-2 border-t border-zinc-800/60">
        Spot snapshot of the CURRENT chain (not a time series). yfinance/Yahoo can be intermittently
        empty/stale — sanity-check before acting.
      </div>
    </PanelShell>
  );
}

// ── Technicals panel ───────────────────────────────────────────────────────────

function TechnicalsPanel({ t }: { t: TechnicalsBlock }) {
  if (!t.available) {
    return (
      <PanelShell title="Technicals" accent="cyan">
        <Unavailable note={t.note ?? 'technicals unavailable'} />
      </PanelShell>
    );
  }
  const aboveSma50 = t.lastClose != null && t.sma50 != null ? t.lastClose >= t.sma50 : null;
  const aboveSma200 = t.lastClose != null && t.sma200 != null ? t.lastClose >= t.sma200 : null;
  return (
    <PanelShell title="Technicals" accent="cyan" subtitle={`Polygon · ${t.rowsUsed} daily closes · last ${t.lastDate ?? 'n/a'}`}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <Row label="last close" value={fmtNum(t.lastClose, 2)} />
        <Row label="52wk range pos" value={t.pctOf52wRange == null ? 'n/a' : `${(t.pctOf52wRange * 100).toFixed(0)}%`} />
        <Row label={`~50d SMA`} value={fmtNum(t.sma50, 2)} hint={aboveSma50 == null ? '' : aboveSma50 ? 'above' : 'below'} />
        <Row label="52wk high" value={fmtNum(t.high52w, 2)} />
        <Row label={`~200d SMA`} value={fmtNum(t.sma200, 2)} hint={aboveSma200 == null ? '' : aboveSma200 ? 'above' : 'below'} />
        <Row label="52wk low" value={fmtNum(t.low52w, 2)} />
        <Row label="1-mo return" value={fmtSignedPctPts(t.mom1mPct)} hint={trendHint(t.mom1mPct)} />
        <Row label="1-yr return" value={fmtSignedPctPts(t.mom1yPct)} hint={trendHint(t.mom1yPct)} />
      </div>
      <div className="text-[9px] font-mono text-zinc-600 mt-3 pt-2 border-t border-zinc-800/60 leading-snug">
        SMAs are tail-means over available closes ({t.rowsUsed} rows) — approximate for short-history
        names. Momentum uses 21 / 252 trading-day offsets.
      </div>
    </PanelShell>
  );
}

// ── Positioning panel ──────────────────────────────────────────────────────────

function PositioningPanel({ p }: { p: PositioningBlock }) {
  if (!p.available) {
    return (
      <PanelShell title="Positioning" accent="emerald">
        <Unavailable note={p.note ?? 'positioning unavailable'} />
      </PanelShell>
    );
  }
  return (
    <PanelShell title="Positioning" accent="emerald" subtitle="insider · short interest · activist">
      {/* Insider */}
      <SubLabel>Insider (trailing 365d, Form 4 P/S)</SubLabel>
      {p.insider ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 mb-3">
          <Row label="buys" value={`${fmtInt(p.insider.buyCount)} · ${fmtUsd(p.insider.buyDollars)}`} />
          <Row label="sells" value={`${fmtInt(p.insider.sellCount)} · ${fmtUsd(p.insider.sellDollars)}`} />
          <Row
            label="net $"
            value={fmtUsd(p.insider.netDollars)}
            hint={p.insider.netDollars > 0 ? 'net buying' : p.insider.netDollars < 0 ? 'net selling' : 'flat'}
          />
        </div>
      ) : <div className="text-[10px] font-mono text-zinc-600 mb-3">no insider filings for this ticker</div>}

      {/* Short interest */}
      <SubLabel>Short interest (latest FINRA)</SubLabel>
      {p.shortInterest ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 mb-3">
          <Row label="settlement" value={p.shortInterest.settlementDate} />
          <Row label="shares short" value={fmtInt(p.shortInterest.sharesShort)} />
          <Row label="Δ vs prior" value={fmtSignedPctPts(p.shortInterest.changePct)} hint={trendHint(p.shortInterest.changePct, true)} />
          <Row label="days to cover" value={p.shortInterest.daysToCover == null ? 'n/a' : p.shortInterest.daysToCover.toFixed(1)} />
        </div>
      ) : <div className="text-[10px] font-mono text-zinc-600 mb-3">no short-interest row for this ticker</div>}

      {/* Activist */}
      <SubLabel>Activist filings (13D / 13G)</SubLabel>
      {p.activist ? (
        <div className="text-[11px] font-mono text-zinc-300">
          {p.activist.total} total ·{' '}
          {p.activist.byForm.map(f => `${f.count}× ${f.formType}`).join(' · ')}
        </div>
      ) : <div className="text-[10px] font-mono text-zinc-600">no 13D/G filings for this ticker</div>}
    </PanelShell>
  );
}

// ── Macro-fit panel ────────────────────────────────────────────────────────────

function MacroFitPanel({ m }: { m: MacroFitBlock }) {
  if (!m.available) {
    return (
      <PanelShell title="Macro fit" accent="amber">
        <Unavailable note={m.note ?? 'macro fit unavailable'} />
      </PanelShell>
    );
  }
  const regimeColor =
    m.regime === 'green' ? 'text-emerald-300'
      : m.regime === 'yellow' ? 'text-yellow-300'
        : m.regime === 'orange' ? 'text-orange-300'
          : m.regime === 'red' ? 'text-red-300'
            : 'text-zinc-300';
  return (
    <PanelShell title="Macro fit" accent="amber" subtitle="market regime + sector context">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <Row label="market regime" value={<span className={`font-bold ${regimeColor}`}>{(m.regime ?? 'n/a').toUpperCase()}</span>} />
        <Row label="as of" value={m.regimeDate ?? 'n/a'} />
        <Row label="GICS sector" value={m.sector ?? 'unmapped'} />
        <Row label="sub-industry" value={m.subIndustry || '—'} />
      </div>
      <div className="text-[9px] font-mono text-zinc-600 mt-3 pt-2 border-t border-zinc-800/60 leading-snug">
        Regime from <code className="text-amber-300">{m.classifierVersion ?? 'macro_regimes'}</code> (the
        market-wide classifier) — it is NOT a per-stock signal. Sector from the SP500 GICS map; tickers
        outside the SP500 show "unmapped".
      </div>
    </PanelShell>
  );
}

// ── Fundamentals panel ─────────────────────────────────────────────────────────

function FundamentalsPanel({ f }: { f: FundamentalsBlock }) {
  if (!f.available) {
    return (
      <PanelShell title="Fundamentals / analyst" accent="sky">
        <Unavailable note={f.note ?? 'fundamentals unavailable'} phase2 />
      </PanelShell>
    );
  }
  const rec = f.recommendation;
  return (
    <PanelShell title="Fundamentals / analyst" accent="sky" subtitle="Finnhub">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <Row label="P/E (TTM)" value={fmtNum(f.peTtm, 1)} />
        <Row label="net margin" value={fmtPct(f.netMarginTtm)} />
        <Row label="ROE" value={fmtPct(f.roeTtm)} />
        <Row label="target (mean)" value={fmtNum(f.priceTargetMean, 2)} />
        <Row label="target hi/lo" value={`${fmtNum(f.priceTargetHigh, 2)} / ${fmtNum(f.priceTargetLow, 2)}`} />
      </div>
      {rec && (
        <div className="text-[11px] font-mono text-zinc-300 mt-3 pt-2 border-t border-zinc-800/60">
          analyst recs ({rec.period}):{' '}
          <span className="text-emerald-300">{rec.strongBuy + rec.buy} buy</span> ·{' '}
          <span className="text-zinc-300">{rec.hold} hold</span> ·{' '}
          <span className="text-red-300">{rec.sell + rec.strongSell} sell</span>
        </div>
      )}
    </PanelShell>
  );
}

// ── Shared primitives ──────────────────────────────────────────────────────────

const ACCENT: Record<string, string> = {
  violet: 'border-violet-500/30',
  cyan: 'border-cyan-500/25',
  emerald: 'border-emerald-500/25',
  amber: 'border-amber-500/25',
  sky: 'border-sky-500/25',
};
const ACCENT_TEXT: Record<string, string> = {
  violet: 'text-violet-300',
  cyan: 'text-cyan-300',
  emerald: 'text-emerald-300',
  amber: 'text-amber-300',
  sky: 'text-sky-300',
};

function PanelShell({
  title, accent, subtitle, children,
}: {
  title: string; accent: string; subtitle?: string; children: ReactNode;
}) {
  return (
    <div className={`border ${ACCENT[accent] ?? 'border-zinc-800'} bg-black rounded p-4`}>
      <div className="flex items-baseline justify-between mb-3">
        <div className={`text-[10px] font-black uppercase tracking-[0.25em] ${ACCENT_TEXT[accent] ?? 'text-zinc-300'}`}>
          {title}
        </div>
        {subtitle && <div className="text-[9px] font-mono text-zinc-600">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function SubLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500 mb-1">
      {children}
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px] font-mono leading-relaxed">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-200 text-right">
        {value}
        {hint ? <span className="text-zinc-600 ml-1">{hint}</span> : null}
      </span>
    </div>
  );
}

function Unavailable({ note, phase2 }: { note: string; phase2?: boolean }) {
  return (
    <div className={`text-[11px] font-mono ${phase2 ? 'text-sky-300/70' : 'text-zinc-500'} leading-relaxed`}>
      {phase2 ? '◷ ' : '○ '}{note}
    </div>
  );
}

// ── Formatters (all Number.isFinite-guarded — no NaN%/Infinity) ───────────────

function fmtNum(v: number | null | undefined, dp: number): string {
  return v != null && Number.isFinite(v) ? v.toFixed(dp) : 'n/a';
}
function fmtInt(v: number | null | undefined): string {
  return v != null && Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : 'n/a';
}
/** Decimal → percent (0.55 → "55.0%"). */
function fmtPct(v: number | null | undefined): string {
  return v != null && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : 'n/a';
}
/** Already-in-percent-points value → "+12.3%" / "−4.0%". */
function fmtSignedPctPts(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v).toFixed(1)}%`;
}
function fmtRatio(v: number | null | undefined): string {
  return v != null && Number.isFinite(v) ? v.toFixed(2) : 'n/a';
}
function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  const abs = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
function biasHint(r: number | null | undefined): string {
  if (r == null || !Number.isFinite(r)) return '';
  if (r > 1.05) return 'put-heavy';
  if (r < 0.95) return 'call-heavy';
  return 'balanced';
}
function trendHint(v: number | null | undefined, shortInterest = false): string {
  if (v == null || !Number.isFinite(v)) return '';
  if (shortInterest) return v > 0 ? 'rising' : v < 0 ? 'falling' : 'flat';
  return v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
}
