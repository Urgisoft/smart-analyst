/**
 * Pure helpers for data-quality decisions: OHLC validation, noise-gate, source priority.
 *
 * Extracted from jupiter_backfill.ts / batch_backtest_worker.ts / clickhouse.ts so each
 * piece can be unit-tested without spinning up workers, network calls, or ClickHouse.
 *
 * Anything in here MUST be pure and deterministic — no IO, no globals, no mutation of args.
 * If you fix a bug in candle ingestion or backtest persistence, the fix lives here and a
 * matching test in scripts/tests/data_quality.test.ts pins it.
 */

// ───── OHLC violation classifier ─────
// Same tolerances as Jupiter's spec recommends. Flags rows where prices are mathematically
// impossible (low > high) or contradict their own bar (open / close outside [low, high]).
export type OHLCViolation = 'non_positive' | 'low_gt_high' | 'open_outside' | 'close_outside';
export interface OHLCRow { open: number; high: number; low: number; close: number; }

export function ohlcViolation(c: OHLCRow): OHLCViolation | null {
  if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) return 'non_positive';
  // 0.1% tolerance — same as the spec. Floating-point and OHLC-aggregation rounding can
  // produce sub-tick discrepancies that aren't real violations.
  if (c.low > c.high * 1.001) return 'low_gt_high';
  const tol = c.high * 0.001;
  if (c.open > c.high + tol || c.open < c.low - tol) return 'open_outside';
  if (c.close > c.high + tol || c.close < c.low - tol) return 'close_outside';
  return null;
}

// ───── Backtest noise gate ─────
// Drop bt_runs rows for params that produced 1..N-1 trades — sample is too small for PF /
// win-rate to be meaningful. trades == 0 stays (legitimate "param never fired" signal).
//
// PF=∞ on n=2 is the canonical failure mode: a memecoin pump triggers two RSI<30 bounces,
// both go positive, and the engine reports +1000% with PF=∞ from a coin-flip.
export function isNoiseZoneTrade(trades: number, minTradesToPersist: number): boolean {
  return trades > 0 && trades < Math.max(0, minTradesToPersist);
}

// ───── Candle source priority ─────
// Lower = more trusted. Jupiter's backfill is canonical (passed the 0% SOL OHLC validation
// gate); legacy okx / kraken / live / geckoterminal feeds are kept as fallbacks for tokens
// where Jupiter has no coverage. The reads in clickhouse.ts pick the highest-priority source
// per (token, interval) — DON'T mix sources for the same token, since their price scales can
// differ by 3x (WMATIC) or 6 orders of magnitude (BLZE).
const PRIORITIES: Record<string, number> = {
  jupiter_v2: 1,
  jupiter_datapi_v2: 1,
  jupiter: 2,
  okx: 3,
  kraken: 4,
  live: 5,
  phase_2_ingest: 6,
  geckoterminal: 7,
};
export function sourcePriority(source: string): number {
  return PRIORITIES[source] ?? 99;
}

// ───── Data-span / statistical-weight helpers ─────
//
// "Data span" is how many days of candle history a backtest saw. Short-history tokens
// (< 90 days) are statistically weak: 30 days captures one regime, can't validate, and is
// almost certainly survivorship-biased (the failed tokens that died in week 1 don't show
// up in token_metadata at all). We compute this once per cell and persist it so the UI
// can filter on the default.

/** Compute days spanned by an ascending-by-time list of candles (or any objects with .time in ms). */
export function computeDataSpanDays(candles: Array<{ time: number }>): number {
  if (candles.length < 2) return 0;
  const first = candles[0].time;
  const last = candles[candles.length - 1].time;
  if (last <= first) return 0;
  return (last - first) / (24 * 60 * 60 * 1000);
}

/** Conservative default minimum data span for a backtest to be statistically meaningful. */
export const DEFAULT_MIN_DATA_SPAN_DAYS = 90;

// ───── Display formatters ─────
//
// JS's Number.prototype.toFixed() falls back to scientific notation for |x| >= 1e21, which is
// how we ended up rendering "+3.5907180999821344e+26%" on the Browse Library leaderboard.
// formatPct compacts huge / tiny numbers into K/M/B/T suffixes and never returns scientific.
// The resulting strings are also a flag for "this number is suspicious" (>1B% probably means
// the row was computed against poisoned multi-source candle data and should be re-run).
export function formatPct(value: number, digits = 1): string {
  if (Number.isNaN(value))    return 'NaN%';
  if (!Number.isFinite(value)) return value > 0 ? '+∞%' : '−∞%';
  const sign = value >= 0 ? '+' : '−';                   // U+2212 minus, narrower than ASCII
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(digits)}T%`;
  if (abs >= 1e9)  return `${sign}${(abs / 1e9).toFixed(digits)}B%`;
  if (abs >= 1e6)  return `${sign}${(abs / 1e6).toFixed(digits)}M%`;
  if (abs >= 1e4)  return `${sign}${(abs / 1e3).toFixed(digits)}K%`;
  // Tiny values still render with the full digit precision.
  return `${sign}${abs.toFixed(digits)}%`;
}

/** Pick the best source from a candidate list. Tiebreak by index (caller may sort by ingested_at first). */
export function pickCanonicalSource(sources: string[]): string | null {
  if (sources.length === 0) return null;
  let bestSource = sources[0];
  let bestPriority = sourcePriority(bestSource);
  for (let i = 1; i < sources.length; i++) {
    const p = sourcePriority(sources[i]);
    if (p < bestPriority) { bestPriority = p; bestSource = sources[i]; }
  }
  return bestSource;
}
