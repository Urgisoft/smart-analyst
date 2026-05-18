/**
 * Signal-time-only feature builder for the meta-labeling pipeline.
 *
 * Hard contract: every feature value at signal index `i` is a function of
 * `candles[0..i]` (inclusive) and `btc.daily[0..d]` where `d` is the most
 * recent BTC daily index whose calendar time ≤ candles[i].time. NO bar at
 * index > i is read for any feature.
 *
 * This contract is enforced by `metaLabelingFeatureLeakage.test.ts` which
 * shuffles bars after `i` and asserts feature values at `i` are unchanged.
 * Any feature added in v1+ MUST pass this audit before merging.
 *
 * Feature definitions per ADR-017 §4 / SPEC §3.2.
 */
import { EMA } from 'technicalindicators';
import { wilderATR } from './atr.js';
import type { Candle } from '../indicators.js';

export interface FeatureRow {
  tokenAddress: string;
  signalIdx: number;
  signalTs: number;
  features: Record<string, number>;
}

export interface BtcContext {
  /** BTC daily candles ascending by time. */
  daily: Candle[];
}

export interface BuildFeaturesArgs {
  tokenAddress: string;
  candles: Candle[];
  signalIdxs: number[];
  btc: BtcContext;
  /** M1's prior trades on this token (exits at or before each signalIdx).
   *  Used for `m1_hit_rate_20` and `m1_pnl_mean_20`. The caller is
   *  responsible for providing only trades that exited at or before the
   *  signal time — this module does not re-validate the temporal order. */
  priorTrades: { exitIdx: number; pnlPct: number }[];
  /** EMA periods used by the primary's signal-strength feature. For
   *  trend_v1: emaFastPeriod = param × 1, emaSlowPeriod = param × 3. */
  emaFastPeriod: number;
  emaSlowPeriod: number;
}

/** Names persisted into meta_train_trades.features (JSON). v0 entries are
 *  frozen (positions 0..8); v1 additions append below the v0 block. The
 *  trainer is feature-set agnostic — it reads whatever columns the JSON
 *  contains (train_meta_label.py META_COLS exclusion) — so growing this
 *  array propagates without a Python change. */
export const V0_FEATURE_NAMES = [
  // ── v0 (ADR-017 §4 / ADR-018) ──
  'vol_pct_30',
  'vol_pct_90',
  'btc_mom_30',
  'btc_vol_pct_90',
  'bars_since_first_seen',
  'tok_volume_pct_90',
  'm1_hit_rate_20',
  'm1_pnl_mean_20',
  'm1_signal_strength',
  // ── v1 additions (ADR-023 candidate: continuous regime-as-feature,
  // motivated by ADR-021's finding that regime IS load-bearing on this
  // universe but binary gating destroyed retention) ──
  'btc_drawdown_depth',
] as const;

const ATR_WINDOW = 20;
const VOL_30 = 30;
const VOL_90 = 90;
const BTC_MOM_DAYS = 30;
const BTC_VOL_DAYS = 90;
const BTC_DRAWDOWN_WINDOW = 200;  // Faber (2007) §2 TAA canonical window; matches train_meta_label.py drawdown-kind regime mask.
const M1_TRADES_WINDOW = 20;
const M1_TRADES_MIN_FOR_HIT_RATE = 5;
const ONE_DAY_MS = 86_400_000;

function percentileRank(values: number[], target: number): number {
  // Empirical CDF rank: fraction of values ≤ target.
  if (values.length === 0) return NaN;
  let count = 0;
  for (const v of values) if (Number.isFinite(v) && v <= target) count++;
  return count / values.length;
}

function realizedVolFromCloses(closes: number[]): number {
  // Standard deviation of log returns over the closes window. Returns NaN
  // if fewer than 3 returns available.
  if (closes.length < 4) return NaN;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 3) return NaN;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  let variance = 0;
  for (const r of rets) variance += (r - mean) ** 2;
  variance /= rets.length;
  return Math.sqrt(variance);
}

interface Precomputed {
  atrAt: (i: number) => number | null;
  atrPctAt: (i: number) => number | null;
  emaFastAt: (i: number) => number | null;
  emaSlowAt: (i: number) => number | null;
  btcDailyByMs: { ts: number; close: number }[];
  btcDailyVols: number[]; // realized vol over the last BTC_VOL_DAYS at each daily index ≥ BTC_VOL_DAYS
  /** Trailing-BTC_DRAWDOWN_WINDOW max of BTC daily close, indexed by BTC daily idx.
   *  NaN at indices < BTC_DRAWDOWN_WINDOW - 1 (insufficient history). */
  btcRollingMax: number[];
}

function precompute(args: BuildFeaturesArgs): Precomputed {
  const { candles, btc, emaFastPeriod, emaSlowPeriod } = args;
  const N = candles.length;

  const closes = candles.map(c => c.close);

  const atrArr = wilderATR(candles, ATR_WINDOW);
  const atrAt = (i: number): number | null => {
    if (i < 0 || i >= atrArr.length) return null;
    const v = atrArr[i];
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const atrPctAt = (i: number): number | null => {
    const a = atrAt(i);
    if (a === null) return null;
    const c = candles[i].close;
    return c > 0 ? a / c : null;
  };

  const fastArr = EMA.calculate({ period: emaFastPeriod, values: closes });
  const slowArr = EMA.calculate({ period: emaSlowPeriod, values: closes });
  const emaFastAt = (i: number): number | null => {
    const j = i - (emaFastPeriod - 1);
    return j >= 0 && j < fastArr.length ? fastArr[j] : null;
  };
  const emaSlowAt = (i: number): number | null => {
    const j = i - (emaSlowPeriod - 1);
    return j >= 0 && j < slowArr.length ? slowArr[j] : null;
  };

  // Pre-sort BTC daily by ms (input is documented ascending; assert defensively).
  const btcDailyByMs = btc.daily
    .map(c => ({ ts: c.time, close: c.close }))
    .sort((a, b) => a.ts - b.ts);

  // Precompute BTC trailing vol at each daily index ≥ BTC_VOL_DAYS.
  const btcDailyVols: number[] = new Array(btcDailyByMs.length).fill(NaN);
  for (let d = BTC_VOL_DAYS; d < btcDailyByMs.length; d++) {
    const sliceCloses = btcDailyByMs.slice(d - BTC_VOL_DAYS, d + 1).map(x => x.close);
    btcDailyVols[d] = realizedVolFromCloses(sliceCloses);
  }

  // Precompute BTC trailing-window max for `btc_drawdown_depth` (v1 feature).
  // O(n*window); ~3000 BTC daily bars × 200 = 600k ops, sub-millisecond. Matches
  // the Python compute_btc_regime_mask "drawdown" kind's same complexity (and
  // its same acknowledged-fine watch-out at higher frequencies).
  const btcRollingMax: number[] = new Array(btcDailyByMs.length).fill(NaN);
  for (let d = BTC_DRAWDOWN_WINDOW - 1; d < btcDailyByMs.length; d++) {
    let mx = -Infinity;
    for (let k = d - BTC_DRAWDOWN_WINDOW + 1; k <= d; k++) {
      const c = btcDailyByMs[k].close;
      if (c > mx) mx = c;
    }
    btcRollingMax[d] = mx;
  }

  void N; // silence unused
  return { atrAt, atrPctAt, emaFastAt, emaSlowAt, btcDailyByMs, btcDailyVols, btcRollingMax };
}

function btcDailyIdxAtOrBefore(btcDaily: { ts: number; close: number }[], tsMs: number): number {
  // Binary search for the largest index whose ts ≤ tsMs.
  let lo = 0, hi = btcDaily.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (btcDaily[mid].ts <= tsMs) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

export function buildFeatures(args: BuildFeaturesArgs): FeatureRow[] {
  const { tokenAddress, candles, signalIdxs, priorTrades } = args;
  const pre = precompute(args);
  const N = candles.length;
  const out: FeatureRow[] = [];

  // Sort prior trades by exitIdx so we can binary-search the rolling window.
  const sortedTrades = [...priorTrades].sort((a, b) => a.exitIdx - b.exitIdx);
  const tradeExitIdxs = sortedTrades.map(t => t.exitIdx);

  for (const signalIdx of signalIdxs) {
    if (signalIdx < 0 || signalIdx >= N) continue;
    const candle = candles[signalIdx];
    const features: Record<string, number> = {};

    // ── vol percentiles ──
    const atrPctNow = pre.atrPctAt(signalIdx);
    if (atrPctNow !== null) {
      const window30: number[] = [];
      for (let j = Math.max(0, signalIdx - VOL_30); j <= signalIdx; j++) {
        const v = pre.atrPctAt(j);
        if (v !== null) window30.push(v);
      }
      features['vol_pct_30'] = percentileRank(window30, atrPctNow);

      const window90: number[] = [];
      for (let j = Math.max(0, signalIdx - VOL_90); j <= signalIdx; j++) {
        const v = pre.atrPctAt(j);
        if (v !== null) window90.push(v);
      }
      features['vol_pct_90'] = percentileRank(window90, atrPctNow);
    } else {
      features['vol_pct_30'] = NaN;
      features['vol_pct_90'] = NaN;
    }

    // ── BTC market context ──
    const btcIdx = btcDailyIdxAtOrBefore(pre.btcDailyByMs, candle.time);
    if (btcIdx >= BTC_MOM_DAYS) {
      const nowClose = pre.btcDailyByMs[btcIdx].close;
      const prevClose = pre.btcDailyByMs[btcIdx - BTC_MOM_DAYS].close;
      features['btc_mom_30'] = Math.sign(nowClose - prevClose);
    } else {
      features['btc_mom_30'] = NaN;
    }
    if (btcIdx >= BTC_VOL_DAYS) {
      const nowVol = pre.btcDailyVols[btcIdx];
      if (Number.isFinite(nowVol)) {
        // Percentile of nowVol within trailing-90-day vol history.
        const start = Math.max(BTC_VOL_DAYS, btcIdx - BTC_VOL_DAYS);
        const window: number[] = [];
        for (let d = start; d <= btcIdx; d++) {
          const v = pre.btcDailyVols[d];
          if (Number.isFinite(v)) window.push(v);
        }
        features['btc_vol_pct_90'] = percentileRank(window, nowVol);
      } else {
        features['btc_vol_pct_90'] = NaN;
      }
    } else {
      features['btc_vol_pct_90'] = NaN;
    }

    // ── BTC drawdown depth (v1) ──
    // Continuous regime-as-feature: positive percentage distance from the
    // trailing-200d BTC max. ADR-021 found that a BINARY drawdown filter
    // collapsed retention; this feature lets LightGBM learn whatever
    // (possibly non-monotonic) shape the data supports without a hard gate.
    if (btcIdx >= BTC_DRAWDOWN_WINDOW - 1) {
      const rmax = pre.btcRollingMax[btcIdx];
      const close = pre.btcDailyByMs[btcIdx].close;
      if (Number.isFinite(rmax) && rmax > 0) {
        features['btc_drawdown_depth'] = ((rmax - close) / rmax) * 100;
      } else {
        features['btc_drawdown_depth'] = NaN;
      }
    } else {
      features['btc_drawdown_depth'] = NaN;
    }

    // ── token meta ──
    features['bars_since_first_seen'] = Math.log(1 + signalIdx);

    const tokVolNow = candle.volume;
    if (Number.isFinite(tokVolNow)) {
      const window: number[] = [];
      for (let j = Math.max(0, signalIdx - VOL_90); j <= signalIdx; j++) {
        const v = candles[j].volume;
        if (Number.isFinite(v)) window.push(v);
      }
      features['tok_volume_pct_90'] = percentileRank(window, tokVolNow);
    } else {
      features['tok_volume_pct_90'] = NaN;
    }

    // ── M1 self-state ──
    // Find the trades whose exitIdx ≤ signalIdx, take the last 20.
    let endTradeIdx = -1;
    {
      let lo = 0, hi = tradeExitIdxs.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (tradeExitIdxs[mid] <= signalIdx) { endTradeIdx = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
    }
    const startTradeIdx = Math.max(0, endTradeIdx - (M1_TRADES_WINDOW - 1));
    const window = endTradeIdx >= 0 ? sortedTrades.slice(startTradeIdx, endTradeIdx + 1) : [];
    if (window.length >= M1_TRADES_MIN_FOR_HIT_RATE) {
      const wins = window.filter(t => t.pnlPct > 0).length;
      features['m1_hit_rate_20'] = wins / window.length;
      features['m1_pnl_mean_20'] = window.reduce((s, t) => s + t.pnlPct, 0) / window.length;
    } else {
      features['m1_hit_rate_20'] = NaN;
      features['m1_pnl_mean_20'] = NaN;
    }

    // ── Signal strength ──
    const f = pre.emaFastAt(signalIdx);
    const s = pre.emaSlowAt(signalIdx);
    const atrNow = pre.atrAt(signalIdx);
    if (f !== null && s !== null && atrNow !== null && atrNow > 0) {
      // (ema_fast − ema_slow) / ATR — unitless signal-strength scale.
      // Larger positive → fast crossed slow with conviction; near zero → marginal.
      features['m1_signal_strength'] = (f - s) / atrNow;
    } else {
      features['m1_signal_strength'] = NaN;
    }

    out.push({ tokenAddress, signalIdx, signalTs: candle.time, features });
  }

  return out;
}

/**
 * What could break this:
 *   - The percentile-rank window includes the signal bar itself. That is by
 *     design (the signal bar is information available at signal time), but
 *     it slightly biases percentile-rank features toward 1.0 when the
 *     signal bar is itself an extreme. If a future feature's percentile
 *     should EXCLUDE the signal bar, it must opt out explicitly.
 *   - BTC daily binary search assumes ascending order; we sort defensively
 *     once at precompute time. If the input BTC array contains duplicates,
 *     the search returns the right-most match — fine for "at-or-before."
 *   - m1_pnl_mean_20 is dominated by extreme winners on tail-driven
 *     strategies (the diagnostic showed mean = +130% on 1318 trades). M2
 *     should treat this as an informative-but-noisy signal, not a clean
 *     point estimate; tree-based models are robust to this.
 *   - When fewer than M1_TRADES_MIN_FOR_HIT_RATE prior trades exist, both
 *     m1_hit_rate_20 and m1_pnl_mean_20 are NaN. The Python trainer's
 *     lightgbm handles NaN natively (treats as missing); other model
 *     families may need explicit imputation.
 */
