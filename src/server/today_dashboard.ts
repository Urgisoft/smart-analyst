/**
 * "Today" command-center dashboard orchestrator — the synthesis landing page.
 *
 * Powers `GET /api/today` for `/#/today` (the new default route). This is the
 * ANSWER-FIRST layer over the 16 dense composite panels: it reads the latest
 * regime / cycle / cross-asset / sector / FTEC state and synthesizes a one-line
 * verdict + plain-language drivers + "what changed" + an attention list, with
 * drill-down links into the dense panels. Read-only; every query is defensive
 * (a missing table degrades that field, never 500s the page) per ADR-044 UI
 * correctness. DECISION-SUPPORT ONLY — describes state, never buy/sell (ADR-056).
 */
import { getClickHouse } from './clickhouse.js';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export interface TodayNumber {
  label: string;
  value: string;
  tone: Tone;
  meaning: string;     // one-line plain-language translation
  href?: string;       // drill-down
}
export interface TodayMover {
  ticker: string;
  weight: number;
  dayPct: number | null;
  price: number | null;
}
export interface TodayAttention { level: 'info' | 'warn'; text: string }
export interface TodayDrillGroup { group: string; links: { label: string; href: string }[] }

export interface TodayPayload {
  asOf: string;
  hasData: boolean;
  verdict: { tone: Tone; headline: string };
  drivers: string[];
  numbers: TodayNumber[];
  ftec: { price: number | null; dayPct: number | null; asOf: string | null; movers: TodayMover[] };
  whatChanged: string[];
  attention: TodayAttention[];
  drilldowns: TodayDrillGroup[];
}

export class TodayDashboardError extends Error {
  status: number;
  error: string;
  detail: string;
  constructor(status: number, error: string, detail: string) {
    super(detail);
    this.status = status;
    this.error = error;
    this.detail = detail;
  }
}

// FTEC top names worth surfacing (weight %); the load-bearing concentration.
const WATCH: [string, number][] = [
  ['NVDA', 16.7], ['AAPL', 14.5], ['MSFT', 9.4], ['MU', 4.2], ['AVGO', 4.2], ['AMD', 3.2],
];

async function rows<T>(sql: string): Promise<T[]> {
  const r = await getClickHouse().query({ query: sql, format: 'JSONEachRow' });
  return r.json<T>();
}
async function one<T>(sql: string): Promise<T | null> {
  try {
    const rs = await rows<T>(sql);
    return rs.length ? rs[0] : null;
  } catch {
    return null;  // missing table / CH hiccup → degrade this field, don't crash the page
  }
}

function lastTradingDay(d: Date): Date {
  const x = new Date(d);
  // LOCAL day-of-week (the data is stamped in the operator's local TZ, e.g. America/Denver).
  // Using UTC here mis-reads the date every evening once UTC rolls to the next day → false stale.
  while (x.getDay() === 0 || x.getDay() === 6) x.setDate(x.getDate() - 1);
  return x;
}
function isoDate(d: Date): string {
  // LOCAL calendar date (NOT toISOString()'s UTC) — see lastTradingDay note. Snapshot dates are local.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

export async function fetchTodayState(): Promise<TodayPayload> {
  const now = new Date();
  const today = isoDate(now);
  const ltd = isoDate(lastTradingDay(now));

  // ── latest composite snapshots (each defensive) ─────────────────────────
  const regime = await one<{ regime: string; d: string; vix: number | null; cats: number | null }>(
    `SELECT regime, toString(trade_date) d, vix_close vix, categories_firing cats
     FROM quantlab.macro_regimes ORDER BY trade_date DESC, ingested_at DESC LIMIT 1`);
  const regimePrev = await one<{ regime: string }>(
    `SELECT regime FROM quantlab.macro_regimes
     WHERE trade_date < (SELECT max(trade_date) FROM quantlab.macro_regimes)
     ORDER BY trade_date DESC LIMIT 1`);
  const cycle = await one<{ phase: string; rp: number; d: string }>(
    `SELECT phase_label phase, round(recession_prob_pct,1) rp, toString(snapshot_date) d
     FROM quantlab.cycle_position_snapshots ORDER BY snapshot_date DESC LIMIT 1`);
  const cyclePrev = await one<{ rp: number }>(
    `SELECT round(recession_prob_pct,1) rp FROM quantlab.cycle_position_snapshots
     WHERE snapshot_date < (SELECT max(snapshot_date) FROM quantlab.cycle_position_snapshots)
     ORDER BY snapshot_date DESC LIMIT 1`);
  const xasset = await one<{ dxy: number | null; uso: number | null; t10y3m: number | null; d: string }>(
    `SELECT round(dxy_close,1) dxy, round(uso_close,1) uso, round(t10y3m,2) t10y3m, toString(snapshot_date) d
     FROM quantlab.cross_asset_snapshots ORDER BY snapshot_date DESC LIMIT 1`);
  const sector = await one<{ flag: string; top: string; d: string }>(
    `SELECT regime_flag flag, top_sector_symbol top, toString(snapshot_date) d
     FROM quantlab.sector_rotation_snapshots ORDER BY snapshot_date DESC LIMIT 1`);

  // ── FTEC + top holdings: last 2 closes per ticker (LIMIT 2 BY) → day move ──
  const tickList = ['FTEC', ...WATCH.map(w => w[0])];
  let priceRows: { ticker: string; d: string; close: number }[] = [];
  try {
    priceRows = await rows(
      `SELECT ticker, toString(date) d, close FROM quantlab.equity_daily_polygon
       WHERE ticker IN (${tickList.map(t => `'${t}'`).join(',')})
       ORDER BY ticker, date DESC LIMIT 2 BY ticker`);
  } catch { priceRows = []; }
  const byTicker = new Map<string, { d: string; close: number }[]>();
  for (const r of priceRows) {
    const arr = byTicker.get(r.ticker) ?? [];
    arr.push({ d: r.d, close: Number(r.close) });
    byTicker.set(r.ticker, arr);
  }
  const dayMove = (t: string): { price: number | null; pct: number | null; asOf: string | null } => {
    const a = byTicker.get(t);
    if (!a || !a.length) return { price: null, pct: null, asOf: null };
    const last = a[0];
    const prev = a[1];
    const pct = prev && prev.close ? (last.close / prev.close - 1) * 100 : null;
    return { price: last.close, pct, asOf: last.d };
  };
  const ftecMove = dayMove('FTEC');
  const movers: TodayMover[] = WATCH.map(([t, w]) => {
    const m = dayMove(t);
    return { ticker: t, weight: w, dayPct: m.pct, price: m.price };
  });

  const hasData = !!(regime || cycle || xasset || ftecMove.price !== null);

  // ── synthesized numbers (plain-language translation on each) ─────────────
  const numbers: TodayNumber[] = [];
  if (regime) {
    const tone: Tone = regime.regime === 'green' ? 'good'
      : regime.regime === 'yellow' ? 'warn'
      : (regime.regime === 'red' || regime.regime === 'orange') ? 'bad' : 'neutral';
    numbers.push({
      label: 'Market regime', value: regime.regime.toUpperCase(), tone, href: '#/regime',
      meaning: tone === 'good' ? 'Risk-on — conditions calm.'
        : tone === 'warn' ? 'Caution — mixed signals, not all-clear.'
        : tone === 'bad' ? 'Risk-off — stress signals firing.' : 'Classifier state.',
    });
  }
  if (cycle && cycle.rp != null) {
    const rp = Number(cycle.rp);
    const tone: Tone = rp < 20 ? 'good' : rp < 40 ? 'warn' : 'bad';
    numbers.push({
      label: 'Recession risk', value: `${rp}%`, tone, href: '#/cycle-position',
      meaning: tone === 'good' ? "Low — economy isn't signaling contraction."
        : tone === 'warn' ? 'Rising — worth watching.' : 'Elevated — contraction signals building.',
    });
  }
  const vix = regime?.vix != null ? Number(regime.vix) : null;
  if (vix != null) {
    const tone: Tone = vix < 18 ? 'good' : vix < 25 ? 'warn' : 'bad';
    numbers.push({
      label: 'Volatility (VIX)', value: vix.toFixed(1), tone, href: '#/regime',
      meaning: tone === 'good' ? 'Calm.' : tone === 'warn' ? 'Elevated — not panic, but jumpy.' : 'Stressed — fear bid.',
    });
  }
  if (xasset && xasset.t10y3m != null) {
    const s = Number(xasset.t10y3m);
    const tone: Tone = s < 0 ? 'bad' : s < 0.5 ? 'warn' : 'neutral';
    numbers.push({
      label: '10Y–3M curve', value: `${s.toFixed(2)}%`, tone, href: '#/cross-asset',
      meaning: s < 0 ? 'Inverted — a classic recession lead.' : 'Positive — normal slope.',
    });
  }
  if (ftecMove.price != null) {
    const p = ftecMove.pct;
    const tone: Tone = p == null ? 'neutral' : p > 0 ? 'good' : p > -1.5 ? 'warn' : 'bad';
    numbers.push({
      label: 'FTEC', value: `$${ftecMove.price.toFixed(2)}`, tone, href: '#/single-stock?ticker=FTEC',
      meaning: p == null ? 'Latest close.' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}% on the day.`,
    });
  }

  // ── drivers (plain language) ─────────────────────────────────────────────
  const drivers: string[] = [];
  if (regime) drivers.push(
    regime.regime === 'green' ? 'Macro regime is GREEN — risk-on, no stress flags.'
    : regime.regime === 'yellow' ? 'Macro regime is YELLOW — mixed/caution: not risk-off, not all-clear.'
    : `Macro regime is ${regime.regime.toUpperCase()} — stress signals are firing; treat rallies with care.`);
  if (cycle && cycle.rp != null) {
    const rp = Number(cycle.rp);
    drivers.push(rp < 20 ? `Recession risk is LOW (${rp}%) — the cycle gauge isn't signaling contraction.`
      : `Recession risk is ${rp}% — ${rp < 40 ? 'worth watching' : 'elevated'}.`);
  }
  const worstMover = movers.filter(m => m.dayPct != null).sort((a, b) => (a.dayPct! - b.dayPct!))[0];
  if (worstMover && worstMover.dayPct != null && worstMover.dayPct < -2) {
    drivers.push(`Your book is semis/AI-heavy (~40% + NVDA ${WATCH[0][1]}%); ${worstMover.ticker} ${worstMover.dayPct.toFixed(1)}% today — concentration is in play.`);
  } else {
    drivers.push(`Your book is semis/AI-heavy (~40% + NVDA ${WATCH[0][1]}%) — the 10Y yield is the key swing factor.`);
  }

  // ── verdict (one line) ───────────────────────────────────────────────────
  let vTone: Tone = 'neutral';
  let headline = 'State loaded.';
  if (regime) {
    const r = regime.regime;
    const rp = cycle?.rp != null ? Number(cycle.rp) : null;
    if (r === 'red' || r === 'orange') { vTone = 'bad'; headline = 'Risk-OFF — stress signals firing; protect first, ask questions later.'; }
    else if (r === 'yellow') {
      vTone = 'warn';
      headline = `Caution — mixed regime${rp != null ? `, recession risk ${rp < 20 ? 'low' : 'rising'} (${rp}%)` : ''}; ${worstMover && worstMover.dayPct != null && worstMover.dayPct < -2 ? 'AI/semis selling off — wait for confirmation, don\'t catch the knife.' : 'no broad stress, but stay selective.'}`;
    } else { vTone = 'good'; headline = `Constructive — regime green${rp != null ? `, recession risk low (${rp}%)` : ''}; conditions calm.`; }
  }

  // ── what changed (vs prior snapshot) ─────────────────────────────────────
  const whatChanged: string[] = [];
  if (regime && regimePrev && regimePrev.regime !== regime.regime)
    whatChanged.push(`Regime flipped ${regimePrev.regime.toUpperCase()} → ${regime.regime.toUpperCase()}.`);
  if (cycle?.rp != null && cyclePrev?.rp != null) {
    const d = Number(cycle.rp) - Number(cyclePrev.rp);
    if (Math.abs(d) >= 1) whatChanged.push(`Recession risk ${d > 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(1)}pp to ${cycle.rp}%.`);
  }
  if (ftecMove.pct != null && Math.abs(ftecMove.pct) >= 1)
    whatChanged.push(`FTEC ${ftecMove.pct >= 0 ? '+' : ''}${ftecMove.pct.toFixed(1)}% on the day.`);
  if (!whatChanged.length) whatChanged.push('No material change vs the prior reading.');

  // ── attention (freshness + stress) ───────────────────────────────────────
  const attention: TodayAttention[] = [];
  const checkFresh = (name: string, d: string | undefined | null, ref: string) => {
    if (!d) { attention.push({ level: 'warn', text: `${name}: no data` }); return; }
    if (daysBetween(d, ref) >= 1) attention.push({ level: 'warn', text: `${name} stale — latest ${d} (expected ${ref})` });
  };
  checkFresh('Regime', regime?.d, ltd);
  checkFresh('Cross-asset', xasset?.d, today);
  checkFresh('Cycle', cycle?.d, today);
  checkFresh('FTEC price', ftecMove.asOf, ltd);
  if (regime && (regime.regime === 'red' || regime.regime === 'orange'))
    attention.push({ level: 'warn', text: `Regime is ${regime.regime.toUpperCase()} — review the macro page.` });
  if (!attention.length) attention.push({ level: 'info', text: 'All core sources fresh; no stress flags.' });

  // ── drill-down nav (the 16 panels, grouped by the question they answer) ──
  const drilldowns: TodayDrillGroup[] = [
    { group: 'Market weather', links: [
      { label: 'Regime', href: '#/regime' }, { label: 'Cycle', href: '#/cycle-position' },
      { label: 'Vol structure', href: '#/vol-structure' }, { label: 'Cross-asset', href: '#/cross-asset' },
      { label: 'Sector rotation', href: '#/sector-rotation' }] },
    { group: 'Positioning & flows', links: [
      { label: 'Short interest', href: '#/short-interest' }, { label: 'Insiders (Form 4)', href: '#/form-4-insider' },
      { label: '13D/G', href: '#/schedule-13d-g' }, { label: '8-K events', href: '#/eight-k' },
      { label: 'Exec departures', href: '#/executive-departure' }, { label: 'ETF flow', href: '#/etf-flow' }] },
    { group: 'Strategy & validation', links: [
      { label: 'Phase B verdicts', href: '#/phase-b' }, { label: 'Cluster', href: '#/cluster' },
      { label: 'Paper trading', href: '#/paper-trading' }, { label: 'Single stock', href: '#/single-stock?ticker=FTEC' }] },
    { group: 'System health', links: [{ label: 'Health & freshness', href: '#/health' }] },
  ];

  return {
    asOf: now.toISOString(),
    hasData,
    verdict: { tone: vTone, headline },
    drivers,
    numbers,
    ftec: { price: ftecMove.price, dayPct: ftecMove.pct, asOf: ftecMove.asOf, movers },
    whatChanged,
    attention,
    drilldowns,
  };
}
