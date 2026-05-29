/**
 * ETF-flow cross-validation dashboard — Gap #9 v3.1 UI surface (s96 #11).
 *
 * Mounted by main.tsx when location.hash matches "#/etf-flow". Surfaces
 * per-ticker shares-outstanding divergence between the v1 yfinance
 * primary panel (`quantlab.etf_shares_outstanding`) and the v3.1
 * issuer-CSV secondary panel (`quantlab.etf_shares_outstanding_secondary`,
 * populated by the SSGA adapter from s96 #7-#9).
 *
 * Closes the operator-validation gap that accumulated across s96 #7-#9
 * — until now the cross-validation comparator's output was only visible
 * in the CLI morning brief §13. This panel is the browser surface so
 * the operator can validate every future v3.1 issuer-adapter slice
 * without tailing brief output.
 *
 * Self-fetches /api/etf-flow/cross-validation on mount + via the refresh
 * button. Renders three modes:
 *   1. `hasData=true`  → summary banner + per-ticker table + top-N
 *      divergence list.
 *   2. `hasData=false` AND secondary table absent → "run the migration"
 *      empty-state with operator commands.
 *   3. `hasData=false` AND secondary table present but empty → "run the
 *      SSGA refresh" empty-state with operator commands.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  EtfFlowCrossValidationStateResponse,
  EtfFlowSecondaryLatestRow,
} from '../../server/etf_flow_dashboard.js';
import type {
  EtfFlowDivergence,
  EtfFlowDivergenceSeverity,
} from '../../server/etf_flow_cross_validation.js';
import { scanEtfFlowAnomalies } from './etfFlowAnomalyScan.js';
import type { Anomaly, AnomalySeverity } from '../composite/anomalyScan.js';

interface State {
  data: EtfFlowCrossValidationStateResponse | null;
  loading: boolean;
  error: string | null;
  lookbackDays: number;
}

const LOOKBACK_OPTIONS: number[] = [30, 90, 365, 730];
const DEFAULT_LOOKBACK = 90;

export default function EtfFlowApp() {
  const [state, setState] = useState<State>({
    data: null,
    loading: true,
    error: null,
    lookbackDays: DEFAULT_LOOKBACK,
  });

  // Cycle 33 slice 3b (S96-147): bug-finding-first anomaly overlay. Scans the
  // cross-validation response so a source disagreement / primary-dark state
  // SCREAMS at the top on render, consistent with the 8 composite panels. Not
  // run in 'empty' mode (the EmptyState explains that case).
  const anomalies = useMemo<Anomaly[]>(
    () => (state.data && state.data.mode !== 'empty' ? scanEtfFlowAnomalies(state.data) : []),
    [state.data],
  );

  const refresh = useCallback(async (lookbackDays: number) => {
    setState(s => ({ ...s, loading: true, error: null, lookbackDays }));
    try {
      const r = await fetch(`/api/etf-flow/cross-validation?lookbackDays=${lookbackDays}`);
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
      const data = await r.json() as EtfFlowCrossValidationStateResponse;
      setState({ data, loading: false, error: null, lookbackDays });
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  useEffect(() => { refresh(DEFAULT_LOOKBACK); }, [refresh]);

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <header className="h-16 border-b border-[#1a1a1a] flex items-center justify-between px-8 bg-black sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-fuchsia-400 animate-pulse shadow-[0_0_10px_rgba(232,121,249,0.5)]" />
          <h2 className="text-xs font-black uppercase tracking-[0.3em] text-white italic">
            VECTOR_ETFFLOW · {state.data?.mode === 'secondary-only'
              ? 'v3.1 secondary panel (primary dark)'
              : 'Cross-validation (v1 yfinance vs v3.1 SSGA)'}
          </h2>
          {state.data?.mode === 'cross-validation' && state.data.summary && (
            <span className="text-[10px] font-mono text-zinc-500 ml-2">
              source: {state.data.summary.secondarySourceLabel} ·{' '}
              {state.data.summary.totalCompared.toLocaleString()} pairs ·{' '}
              {state.data.summary.divergenceCount} divergences
            </span>
          )}
          {state.data?.mode === 'secondary-only' && (
            <span className="text-[10px] font-mono text-amber-300/80 ml-2">
              {state.data.counts.secondaryRows.toLocaleString()} secondary rows ·{' '}
              {(state.data.secondaryLatest?.length ?? 0)} tickers
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 text-[10px] font-mono">
            <span className="text-zinc-500 uppercase tracking-[0.15em]">window</span>
            {LOOKBACK_OPTIONS.map(opt => (
              <button
                key={opt}
                onClick={() => refresh(opt)}
                disabled={state.loading}
                className={`px-2 py-0.5 rounded border transition-colors ${
                  state.lookbackDays === opt
                    ? 'border-fuchsia-400/60 text-fuchsia-200 bg-fuchsia-400/10'
                    : 'border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {opt}d
              </button>
            ))}
          </div>
          <a
            href="/"
            className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500 hover:text-white transition-colors"
          >
            ← back
          </a>
          <button
            onClick={() => refresh(state.lookbackDays)}
            disabled={state.loading}
            className="text-[10px] font-mono uppercase tracking-[0.2em] text-fuchsia-300 hover:text-fuchsia-100 border border-fuchsia-400/30 hover:border-fuchsia-400/60 rounded px-3 py-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {state.loading ? 'loading…' : 'refresh'}
          </button>
        </div>
      </header>

      <main className="p-6 max-w-[1600px] mx-auto">
        {state.data?.mode === 'secondary-only' ? (
          <PrimaryDarkBanner data={state.data} />
        ) : (
          <SpecBanner />
        )}
        {state.data && state.data.mode !== 'empty' && (
          <AnomalyBanner anomalies={anomalies} />
        )}
        {state.error && (
          <div className="border border-red-500/40 bg-red-500/10 rounded p-4 mb-4">
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-red-300 mb-1">
              Failed to load etf-flow cross-validation state
            </div>
            <div className="text-[11px] font-mono text-red-200/80">{state.error}</div>
          </div>
        )}

        {state.loading && !state.data && (
          <div className="text-[11px] font-mono text-zinc-500">loading etf-flow cross-validation…</div>
        )}

        {/* Cycle 20 (s96 #19): dispatch on the response's `mode` field. */}
        {state.data?.mode === 'empty' && (
          <EmptyState data={state.data} />
        )}

        {state.data?.mode === 'cross-validation' && state.data.summary && (
          <Dashboard data={state.data} />
        )}

        {state.data?.mode === 'secondary-only' && state.data.secondaryLatest && (
          <SecondaryOnlyDashboard
            data={state.data}
            secondaryLatest={state.data.secondaryLatest}
          />
        )}
      </main>
    </div>
  );
}

function SpecBanner() {
  return (
    <div className="border border-fuchsia-500/30 bg-fuchsia-500/5 rounded p-3 mb-4 flex items-start gap-3">
      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-fuchsia-300 whitespace-nowrap pt-0.5">
        Gap #9 v3.1
      </div>
      <div className="text-[11px] font-mono text-fuchsia-100/80 leading-relaxed">
        Compares the <span className="text-fuchsia-300 font-bold">yfinance primary</span>{' '}
        (<code className="text-fuchsia-300">etf_shares_outstanding</code>) against the{' '}
        <span className="text-fuchsia-300 font-bold">issuer-CSV secondary</span>{' '}
        (<code className="text-fuchsia-300">etf_shares_outstanding_secondary</code>, populated
        by the SSGA adapter from s96 #7-#9). Severity ladder: <span className="text-zinc-400">info</span>{' '}
        &lt;2% · <span className="text-amber-300">warn</span> 2-5% ·{' '}
        <span className="text-red-300">critical</span> ≥5%. SPEC:{' '}
        <code className="text-fuchsia-300">docs/specs/etf-flow-monitoring.md §11 OQ3</code>.
      </div>
    </div>
  );
}

/** Cycle 20 (s96 #19): primary-dark banner. Renders when the v1 yfinance
 *  primary is empty but the v3.1 secondary panel has data — the panel
 *  falls back to secondary-only mode per ADR-049 + Q-6.
 *
 *  Honest-banner rule per ADR-044 §UI: the operator MUST see that this
 *  is secondary-source data, not silent. The cross-validation
 *  sub-panels are hidden because the comparison would be meaningless
 *  with one side empty. */
function PrimaryDarkBanner({ data }: { data: EtfFlowCrossValidationStateResponse }) {
  return (
    <div className="border border-amber-500/40 bg-amber-500/5 rounded p-3 mb-4 flex items-start gap-3">
      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-300 whitespace-nowrap pt-0.5">
        Primary dark
      </div>
      <div className="text-[11px] font-mono text-amber-100/80 leading-relaxed">
        v1 primary (<code className="text-amber-200">yfinance Ticker.get_shares_full</code>) returned{' '}
        <span className="text-amber-300 font-bold">0 rows</span> in the last {data.lookbackDays}d window.
        Yahoo broke the ETF SHO endpoint ~2026-05-19 (S96-89); panel data shown below is from{' '}
        <span className="text-amber-300 font-bold">v3.1 secondary sources</span> per{' '}
        <code className="text-amber-200">ADR-049</code> (SSGA SPDR adapter for 15 tickers +{' '}
        stockanalysis.com free-aggregator scrape for 5 tickers). Cross-validation sub-panels are{' '}
        suppressed because the primary/secondary comparison is meaningless with one side empty;{' '}
        resolution paths tracked under operator queue{' '}
        <span className="text-fuchsia-300 font-bold">Q-6</span>.
      </div>
    </div>
  );
}

function Dashboard({ data }: { data: EtfFlowCrossValidationStateResponse }) {
  if (!data.summary) return null;
  const { summary } = data;
  return (
    <div className="grid grid-cols-1 gap-4">
      <SummaryPanel data={data} />
      <TopDivergencesPanel divergences={summary.topDivergences} />
      <PerTickerPanel byTicker={summary.byTicker} />
    </div>
  );
}

/** Cycle 20 (s96 #19): secondary-only dashboard. Renders the v3.1
 *  secondary panel as the source-of-truth display when primary is dark.
 *  Layout mirrors `Dashboard` (summary tiles + per-ticker table) for
 *  visual continuity; the cross-validation-specific panels
 *  (TopDivergencesPanel, PerTickerPanel comparing primary vs secondary)
 *  are intentionally omitted because the comparison is meaningless. */
function SecondaryOnlyDashboard({
  data,
  secondaryLatest,
}: {
  data: EtfFlowCrossValidationStateResponse;
  secondaryLatest: ReadonlyArray<EtfFlowSecondaryLatestRow>;
}) {
  return (
    <div className="grid grid-cols-1 gap-4">
      <SecondaryOnlySummaryPanel data={data} rows={secondaryLatest} />
      <SecondaryOnlyTablePanel rows={secondaryLatest} />
    </div>
  );
}

function SecondaryOnlySummaryPanel({
  data,
  rows,
}: {
  data: EtfFlowCrossValidationStateResponse;
  rows: ReadonlyArray<EtfFlowSecondaryLatestRow>;
}) {
  // Roll-up tiles — operator-readable freshness signals over the v3.1
  // secondary panel. AUM totals are the sum of per-ticker latest aum;
  // distinct dates surface freshness staleness if some tickers are
  // missing their most-recent row.
  const tickerCount = rows.length;
  const totalAum = rows.reduce(
    (acc, r) => (Number.isFinite(r.aum) ? acc + r.aum : acc),
    0,
  );
  const distinctLatestDates = new Set(rows.map(r => r.date));
  const sortedDates = [...distinctLatestDates].sort();
  const oldestLatest = sortedDates[0] ?? '—';
  const newestLatest = sortedDates[sortedDates.length - 1] ?? '—';
  const tickersWithDelta = rows.filter(r => r.sharesPctDelta != null).length;

  const tiles: Array<{ label: string; value: string; color: string }> = [
    { label: 'Tickers (latest)', value: tickerCount.toLocaleString(), color: 'text-amber-200' },
    { label: 'Secondary rows (window)', value: data.counts.secondaryRows.toLocaleString(), color: 'text-amber-200' },
    { label: 'Total AUM (latest)', value: formatAum(totalAum), color: 'text-amber-200' },
    { label: 'Latest date — newest', value: newestLatest, color: 'text-amber-200' },
    { label: 'Latest date — oldest', value: oldestLatest, color: 'text-zinc-400' },
    { label: 'With day-over-day delta', value: `${tickersWithDelta}/${tickerCount}`, color: 'text-zinc-400' },
  ];

  return (
    <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4">
      <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-3">
        Secondary panel rollup · as of {data.asOf} · {data.lookbackDays}d lookback
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {tiles.map(t => (
          <div key={t.label} className="border border-[#1a1a1a] rounded bg-black/40 p-2">
            <div className="text-[8px] font-mono uppercase tracking-[0.15em] text-zinc-500 mb-1">
              {t.label}
            </div>
            <div className={`text-sm font-mono font-bold ${t.color}`}>{t.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SecondaryOnlyTablePanel({
  rows,
}: {
  rows: ReadonlyArray<EtfFlowSecondaryLatestRow>;
}) {
  return (
    <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4">
      <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-3">
        Per-ticker latest snapshot ({rows.length} ticker{rows.length === 1 ? '' : 's'} from v3.1 secondary)
      </div>
      {rows.length === 0 ? (
        <div className="text-[11px] font-mono text-zinc-500">
          No secondary rows in window.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr className="text-zinc-500 border-b border-[#1a1a1a]">
                <th className="text-left py-1 px-2 uppercase tracking-[0.15em]">Ticker</th>
                <th className="text-left py-1 px-2 uppercase tracking-[0.15em]">Latest date</th>
                <th className="text-right py-1 px-2 uppercase tracking-[0.15em]">Shares</th>
                <th className="text-right py-1 px-2 uppercase tracking-[0.15em]">Close</th>
                <th className="text-right py-1 px-2 uppercase tracking-[0.15em]">AUM</th>
                <th className="text-left py-1 px-2 uppercase tracking-[0.15em]">Prior date</th>
                <th className="text-right py-1 px-2 uppercase tracking-[0.15em]">Δshares (DoD)</th>
                <th className="text-right py-1 px-2 uppercase tracking-[0.15em]">Rows</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.ticker} className="border-b border-[#0f0f0f] hover:bg-white/5">
                  <td className="py-1 px-2 text-white font-bold">{r.ticker}</td>
                  <td className="py-1 px-2 text-zinc-300">{r.date}</td>
                  <td className="py-1 px-2 text-right text-zinc-300">{formatShares(r.shares)}</td>
                  <td className="py-1 px-2 text-right text-zinc-300">{formatClose(r.close)}</td>
                  <td className="py-1 px-2 text-right text-amber-200">{formatAum(r.aum)}</td>
                  <td className="py-1 px-2 text-zinc-500">{r.previousDate ?? '—'}</td>
                  <td className={`py-1 px-2 text-right font-bold ${signedColor(r.sharesPctDelta ?? 0)}`}>
                    {r.sharesPctDelta == null ? '—' : formatSignedPct(r.sharesPctDelta)}
                  </td>
                  <td className="py-1 px-2 text-right text-zinc-400">{r.rowCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SummaryPanel({ data }: { data: EtfFlowCrossValidationStateResponse }) {
  if (!data.summary) return null;
  const { summary, counts } = data;
  const tiles: Array<{ label: string; value: string; color: string }> = [
    { label: 'Pairs compared', value: summary.totalCompared.toLocaleString(), color: 'text-fuchsia-300' },
    { label: 'Divergences', value: summary.divergenceCount.toLocaleString(), color: 'text-fuchsia-300' },
    { label: 'Critical', value: String(summary.bySeverity.critical), color: 'text-red-300' },
    { label: 'Warn', value: String(summary.bySeverity.warn), color: 'text-amber-300' },
    { label: 'Info', value: String(summary.bySeverity.info), color: 'text-zinc-300' },
    { label: 'Max |Δshares|', value: formatPct(summary.maxAbsSharesPctDiff), color: 'text-fuchsia-300' },
    { label: 'Max |ΔAUM|', value: formatPct(summary.maxAbsAumPctDiff), color: 'text-fuchsia-300' },
    { label: 'Primary rows', value: counts.primaryRows.toLocaleString(), color: 'text-zinc-400' },
    { label: 'Secondary rows', value: counts.secondaryRows.toLocaleString(), color: 'text-zinc-400' },
  ];
  return (
    <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4">
      <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-3">
        Summary · as of {data.asOf} · {data.lookbackDays}d lookback
      </div>
      <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-3">
        {tiles.map(t => (
          <div key={t.label} className="border border-[#1a1a1a] rounded bg-black/40 p-2">
            <div className="text-[8px] font-mono uppercase tracking-[0.15em] text-zinc-500 mb-1">
              {t.label}
            </div>
            <div className={`text-sm font-mono font-bold ${t.color}`}>{t.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TopDivergencesPanel({ divergences }: { divergences: ReadonlyArray<EtfFlowDivergence> }) {
  return (
    <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4">
      <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-3">
        Top divergences (worst-first)
      </div>
      {divergences.length === 0 ? (
        <div className="text-[11px] font-mono text-emerald-400/80">
          No divergences above entry threshold (0.5%). The primary and secondary panels agree.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr className="text-zinc-500 border-b border-[#1a1a1a]">
                <th className="text-left py-1 px-2 uppercase tracking-[0.15em]">Ticker</th>
                <th className="text-left py-1 px-2 uppercase tracking-[0.15em]">Date</th>
                <th className="text-right py-1 px-2 uppercase tracking-[0.15em]">Primary shares</th>
                <th className="text-right py-1 px-2 uppercase tracking-[0.15em]">Secondary shares</th>
                <th className="text-right py-1 px-2 uppercase tracking-[0.15em]">Δshares</th>
                <th className="text-right py-1 px-2 uppercase tracking-[0.15em]">ΔAUM</th>
                <th className="text-center py-1 px-2 uppercase tracking-[0.15em]">Severity</th>
              </tr>
            </thead>
            <tbody>
              {divergences.map((d, i) => (
                <tr key={`${d.ticker}-${d.date}-${i}`} className="border-b border-[#0f0f0f] hover:bg-white/5">
                  <td className="py-1 px-2 text-white font-bold">{d.ticker}</td>
                  <td className="py-1 px-2 text-zinc-400">{d.date}</td>
                  <td className="py-1 px-2 text-right text-zinc-300">{formatShares(d.primaryShares)}</td>
                  <td className="py-1 px-2 text-right text-zinc-300">{formatShares(d.secondaryShares)}</td>
                  <td className={`py-1 px-2 text-right font-bold ${signedColor(d.sharesPctDiff)}`}>
                    {formatSignedPct(d.sharesPctDiff)}
                  </td>
                  <td className={`py-1 px-2 text-right font-bold ${signedColor(d.aumPctDiff)}`}>
                    {formatSignedPct(d.aumPctDiff)}
                  </td>
                  <td className="py-1 px-2 text-center">
                    <SeverityBadge severity={d.severity} />
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

function PerTickerPanel({
  byTicker,
}: {
  byTicker: Readonly<Record<string, { compared: number; diverged: number; maxAbsSharesPctDiff: number }>>;
}) {
  const entries = Object.entries(byTicker).sort((a, b) => b[1].maxAbsSharesPctDiff - a[1].maxAbsSharesPctDiff);
  return (
    <div className="border border-[#1a1a1a] rounded-xl bg-[#0a0a0a] p-4">
      <div className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-3">
        Per-ticker divergence counts ({entries.length} ticker{entries.length === 1 ? '' : 's'} with divergences)
      </div>
      {entries.length === 0 ? (
        <div className="text-[11px] font-mono text-emerald-400/80">
          Every ticker matched. Primary and secondary panels agree across the entire window.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
          {entries.map(([ticker, stats]) => (
            <div key={ticker} className="border border-[#1a1a1a] rounded bg-black/40 p-2">
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-xs font-bold text-white">{ticker}</span>
                <span className="text-[9px] font-mono text-zinc-500">
                  {stats.diverged}× div
                </span>
              </div>
              <div className="text-[10px] font-mono text-fuchsia-300">
                max |Δshares| {formatPct(stats.maxAbsSharesPctDiff)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: EtfFlowDivergenceSeverity }) {
  const map: Record<EtfFlowDivergenceSeverity, { bg: string; border: string; text: string }> = {
    info: { bg: 'bg-zinc-500/10', border: 'border-zinc-500/40', text: 'text-zinc-300' },
    warn: { bg: 'bg-amber-500/10', border: 'border-amber-500/40', text: 'text-amber-300' },
    critical: { bg: 'bg-red-500/10', border: 'border-red-500/40', text: 'text-red-300' },
  };
  const cls = map[severity];
  return (
    <span className={`inline-block px-2 py-0.5 rounded border text-[9px] font-bold uppercase tracking-[0.15em] ${cls.bg} ${cls.border} ${cls.text}`}>
      {severity}
    </span>
  );
}

function EmptyState({ data }: { data: EtfFlowCrossValidationStateResponse }) {
  const { counts } = data;
  // GAP-11 (s96 #12): primary-table-missing branch added. Without it, a fresh
  // clone that never ran the v1 migration crashed the route (the screenshot
  // bug). Order matters: primary-missing takes precedence — without primary
  // there's no cross-validation at all, secondary-state is irrelevant until
  // primary exists.
  const primaryAbsent = !counts.primaryTableExists;
  const secondaryAbsent = !counts.secondaryTableExists;
  let title: string;
  let body: ReactNode;
  let commands: string;
  if (primaryAbsent) {
    title = 'Primary table not yet migrated';
    body = (
      <>
        <code className="text-amber-200">quantlab.etf_shares_outstanding</code> does not exist in
        ClickHouse. The s92 migration creates it; alternatively the v1 ingest creates it on first
        apply-run. Run either path, then refresh.
      </>
    );
    commands = `# Option A — apply the s92 migration (creates BOTH the primary table
# AND quantlab.etf_flow_snapshots in one shot, idempotent):
npm run migrate:create-etf-flow-snapshots
npm run migrate:create-etf-flow-snapshots:apply

# Option B — let the ingest create the table on first apply:
npm run etf:flow:ingest

# Then bootstrap the secondary panel if not already done:
npm run migrate:create-etf-shares-outstanding-secondary:apply
npm run etf:flow:ssga-spdr:refresh`;
  } else if (secondaryAbsent) {
    title = 'Secondary table not yet migrated';
    body = (
      <>
        <code className="text-amber-200">quantlab.etf_shares_outstanding_secondary</code> does not
        exist in ClickHouse. Apply the migration first, then refresh the SSGA panel.
      </>
    );
    commands = `# 1. Apply the secondary-table migration (idempotent):
npm run migrate:create-etf-shares-outstanding-secondary
npm run migrate:create-etf-shares-outstanding-secondary:apply

# 2. Populate the SSGA panel + ingest to CH:
npm run etf:flow:ssga-spdr:refresh`;
  } else {
    // Both tables exist. At least one panel is empty in the window. Cycle 12
    // (s96 #17) refactored this branch to distinguish primary-empty vs
    // secondary-empty vs both — the prior single message ("Run the v3.1 SSGA
    // refresh") was misleading when the SSGA secondary was healthy and the
    // yfinance primary was the empty side.
    const primaryEmpty = counts.primaryRows === 0;
    const secondaryEmpty = counts.secondaryRows === 0;
    if (primaryEmpty && !secondaryEmpty) {
      // S96-89: Yahoo broke `Ticker.get_shares_full` for ETFs (~2026); the
      // endpoint returns empty for all 21 F-UNIVERSE tickers while still
      // working for equities (AAPL/MSFT). yfinance 1.4.0 doesn't fix it
      // (Yahoo-side regression). The v1 primary panel cannot be backfilled
      // from yfinance until Yahoo restores the endpoint OR the operator
      // resolves Q-6 (methodology amendment OR paid-data subscription).
      title = 'Primary panel empty — yfinance ETF SHO endpoint regression';
      body = (
        <>
          Primary panel (<code className="text-amber-200">quantlab.etf_shares_outstanding</code>) has{' '}
          <span className="text-amber-300 font-bold">0</span> rows; secondary panel has{' '}
          <span className="text-amber-300 font-bold">{counts.secondaryRows.toLocaleString()}</span> rows
          in the last {data.lookbackDays}d window. Yahoo broke{' '}
          <code className="text-amber-200">Ticker.get_shares_full</code> for ETFs (~2026
          regression) — the endpoint returns empty for all 21 F-UNIVERSE tickers while
          still working for equities. Running the ingest will not help; the cross-validation
          comparator is blocked on operator queue <span className="text-fuchsia-300 font-bold">Q-6</span>
          {' '}(methodology amendment OR paid-data subscription). See HEALTH dashboard for the quarantine row.
        </>
      );
      commands = `# Yahoo ETF SHO endpoint regression — informational only.
# Running the ingest will print "FAILED (shares=0, close=N)" for all 21 ETFs
# and exit 1. The v3.1 SSGA secondary covers SPY + 11 SPDR sectors (12 of 21);
# the remaining 9 (IVV/VOO/QQQ/IWM/DIA/HYG/JNK/TLT/GLD) have no v3.1 alternative.
#
# Resolution paths — operator queue Q-6:
#   (A) paid Sharadar / Polygon ETF SHO subscription
#   (B) methodology amendment: promote v3.1 secondary to primary,
#       drop the 9 non-SPDR tickers from F-UNIVERSE
#   (C) keep "accepted-as-warning" indefinitely (cross-validation degraded)
#
# Diagnostic (will fail but surfaces the regression pattern):
npm run etf:flow:ingest:dry`;
    } else if (!primaryEmpty && secondaryEmpty) {
      title = 'Awaiting first SSGA refresh';
      body = (
        <>
          Primary panel has{' '}
          <span className="text-amber-300 font-bold">{counts.primaryRows.toLocaleString()}</span> rows;
          secondary panel (<code className="text-amber-200">quantlab.etf_shares_outstanding_secondary</code>)
          {' '}has <span className="text-amber-300 font-bold">0</span> rows in the last{' '}
          {data.lookbackDays}d window. Run the v3.1 SSGA refresh to populate.
        </>
      );
      commands = `# Populate the SSGA panel + ingest to CH:
npm run etf:flow:ssga-spdr:refresh

# Or wait for the next daemon:daily cycle — step 1ja
# auto-refreshes the panel (s96 #9):
npm run daemon:daily`;
    } else {
      title = 'Both panels empty';
      body = (
        <>
          Primary panel has{' '}
          <span className="text-amber-300 font-bold">{counts.primaryRows.toLocaleString()}</span> rows;
          secondary panel has{' '}
          <span className="text-amber-300 font-bold">{counts.secondaryRows.toLocaleString()}</span> rows
          in the last {data.lookbackDays}d window. Bootstrap both panels.
        </>
      );
      commands = `# Populate the SSGA secondary panel:
npm run etf:flow:ssga-spdr:refresh

# Attempt v1 primary ingest (may fail per S96-89 Yahoo regression):
npm run etf:flow:ingest

# Or wait for the next daemon:daily cycle (steps 1ja + 1jb):
npm run daemon:daily`;
    }
  }
  return (
    <div className="border border-amber-500/30 bg-amber-500/5 rounded p-6">
      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-300 mb-2">
        {title}
      </div>
      <div className="text-[11px] font-mono text-amber-100/80 leading-relaxed mb-3">
        {body}
      </div>
      <pre className="text-[10px] font-mono text-amber-200 bg-black/40 border border-amber-500/20 rounded p-3 leading-snug overflow-x-auto">
{commands}
      </pre>
      <div className="text-[10px] font-mono text-zinc-500 mt-3">
        SPEC: <code className="text-fuchsia-300">docs/specs/etf-flow-monitoring.md §11 OQ3</code> ·
        v3.1 arc: s96 #7 (adapter) → s96 #8 (wrapper) → s96 #9 (daemon hook) → s96 #11 (this panel) →
        s96 #12 (primary guard + /#/health surface).
      </div>
    </div>
  );
}

// ── Anomaly banner (Cycle 33 slice 3b — bug-finding-first overlay) ───────────
// Visual matches CompositeDetailApp's AnomalyBanner so the bug-finding-first UX
// is identical across all panels (inline-hex; dynamic Tailwind classes purge).
// Kept local (not imported from CompositeDetailApp) because EtfFlowApp is a
// fully bespoke panel with its own header/formatters — same posture as the
// rest of this file.

const SEVERITY_HEX: Record<AnomalySeverity, string> = {
  critical: '#f87171', warn: '#fbbf24', info: '#a1a1aa',
};

function AnomalyBanner({ anomalies }: { anomalies: Anomaly[] }) {
  if (anomalies.length === 0) {
    return (
      <div className="border border-emerald-500/25 bg-emerald-500/[0.04] rounded px-3 py-2 mb-4 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <span className="text-[10px] font-mono text-emerald-300/80 uppercase tracking-[0.15em]">
          anomaly scan clean — primary and secondary agree; no implausible divergence or primary-dark
        </span>
      </div>
    );
  }
  return (
    <div className="border border-zinc-700/60 bg-black/40 rounded p-3 mb-4 flex flex-col gap-1.5">
      <div className="text-[9px] font-black uppercase tracking-[0.25em] text-zinc-400 mb-0.5">
        Anomaly scan — {anomalies.length} flag{anomalies.length === 1 ? '' : 's'}
      </div>
      {anomalies.map((a, i) => (
        <div key={`${a.code}-${i}`} className="flex items-start gap-2">
          <span
            className="text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded whitespace-nowrap mt-px"
            style={{ color: SEVERITY_HEX[a.severity], border: `1px solid ${SEVERITY_HEX[a.severity]}55`, backgroundColor: `${SEVERITY_HEX[a.severity]}14` }}
          >
            {a.severity}
          </span>
          <span className="text-[11px] font-mono leading-snug" style={{ color: `${SEVERITY_HEX[a.severity]}dd` }}>
            <span className="text-zinc-500">[{a.code}]</span> {a.message}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Formatting helpers ──────────────────────────────────────────────────────
// GAP-12 (s96 #12): all formatters guard non-finite inputs explicitly so a
// null/undefined CH column renders as `—` instead of `NaN%` / `Infinity` /
// `1.23e+47`. Mirrors the App.tsx fmtPF pattern.

function formatPct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

function formatSignedPct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(2)}%`;
}

function formatShares(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(0);
}

function formatClose(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}`;
}

function formatAum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(0)}`;
}

function signedColor(pct: number): string {
  if (Math.abs(pct) >= 0.05) return pct > 0 ? 'text-red-300' : 'text-red-300';
  if (Math.abs(pct) >= 0.02) return 'text-amber-300';
  return 'text-zinc-300';
}
