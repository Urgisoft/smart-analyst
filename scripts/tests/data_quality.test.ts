/**
 * Unit tests for the data-quality helpers.
 *
 * Each block covers a specific bug we hit in production — the test name should make it
 * obvious WHICH bug it pins so future regressions are caught in CI rather than discovered
 * by the user. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ohlcViolation,
  isNoiseZoneTrade,
  sourcePriority,
  pickCanonicalSource,
  formatPct,
  computeDataSpanDays,
  DEFAULT_MIN_DATA_SPAN_DAYS,
} from '../_data_quality.js';

describe('ohlcViolation', () => {
  it('accepts a normal candle', () => {
    assert.equal(ohlcViolation({ open: 100, high: 110, low: 90, close: 105 }), null);
  });

  it('flags non-positive prices', () => {
    assert.equal(ohlcViolation({ open: 0, high: 110, low: 90, close: 105 }), 'non_positive');
    assert.equal(ohlcViolation({ open: 100, high: 110, low: 0, close: 105 }), 'non_positive');
    assert.equal(ohlcViolation({ open: -1, high: 110, low: 90, close: 105 }), 'non_positive');
  });

  it('flags low > high (mathematically impossible)', () => {
    assert.equal(ohlcViolation({ open: 100, high: 90, low: 110, close: 105 }), 'low_gt_high');
  });

  it('tolerates 0.1% rounding slop on low > high', () => {
    // low=100.05, high=100 → low > high BUT low <= high * 1.001 (= 100.1) → not a violation.
    assert.equal(ohlcViolation({ open: 100, high: 100, low: 100.05, close: 100 }), null);
  });

  it('flags open outside [low, high] beyond tolerance', () => {
    // open is 1% above high — that's beyond the 0.1% tolerance.
    assert.equal(ohlcViolation({ open: 121, high: 120, low: 100, close: 110 }), 'open_outside');
  });

  it('flags close outside [low, high] beyond tolerance — the BLZE memecoin pattern', () => {
    // close way below low. This was the most common violation in the real Jupiter data.
    assert.equal(ohlcViolation({ open: 100, high: 110, low: 99, close: 50 }), 'close_outside');
  });

  it('accepts close exactly equal to high (single-tick bar)', () => {
    assert.equal(ohlcViolation({ open: 100, high: 100, low: 100, close: 100 }), null);
  });
});

describe('isNoiseZoneTrade', () => {
  // The PF=∞ on n=2 bug — the canonical failure mode this gate exists to prevent.
  it('drops 1..N-1 trades (the noise zone)', () => {
    assert.equal(isNoiseZoneTrade(1, 10), true);
    assert.equal(isNoiseZoneTrade(2, 10), true);   // BLZE-style PF=∞ on 2 winning pumps
    assert.equal(isNoiseZoneTrade(9, 10), true);   // just under the threshold
  });

  it('keeps trades >= N (statistically meaningful)', () => {
    assert.equal(isNoiseZoneTrade(10, 10), false);
    assert.equal(isNoiseZoneTrade(50, 10), false);
  });

  it('KEEPS trades == 0 — legitimate "param never fired" signal', () => {
    // Critical: a row showing "this param produced 0 trades" is real diagnostic info and
    // sorts to the bottom of leaderboards anyway. We don't want to confuse "never fired"
    // with "noise dropped".
    assert.equal(isNoiseZoneTrade(0, 10), false);
  });

  it('disabled when threshold = 0', () => {
    assert.equal(isNoiseZoneTrade(1, 0), false);
    assert.equal(isNoiseZoneTrade(100, 0), false);
  });

  it('clamps negative thresholds (defensive — should never happen but be safe)', () => {
    assert.equal(isNoiseZoneTrade(5, -10), false);
  });
});

describe('sourcePriority', () => {
  it('ranks Jupiter v2 sources highest (= 1)', () => {
    assert.equal(sourcePriority('jupiter_v2'), 1);
    assert.equal(sourcePriority('jupiter_datapi_v2'), 1);
  });

  it('orders the known sources from most- to least-trusted', () => {
    // Strict ordering — if anyone reorders these in _data_quality.ts, this test catches it.
    assert.ok(sourcePriority('jupiter_v2') < sourcePriority('jupiter'));
    assert.ok(sourcePriority('jupiter') < sourcePriority('okx'));
    assert.ok(sourcePriority('okx') < sourcePriority('kraken'));
    assert.ok(sourcePriority('kraken') < sourcePriority('live'));
    assert.ok(sourcePriority('live') < sourcePriority('phase_2_ingest'));
    assert.ok(sourcePriority('phase_2_ingest') < sourcePriority('geckoterminal'));
  });

  it('assigns priority 99 to unknown sources (so they lose ties to anything known)', () => {
    assert.equal(sourcePriority('mystery_feed'), 99);
    assert.equal(sourcePriority(''), 99);
  });
});

describe('computeDataSpanDays', () => {
  // Pin: this is the per-row data-span signal that drives the "this token is too short for a
  // statistically meaningful backtest" filter. If the math drifts, every "Min hist" filter
  // result is wrong.
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  it('returns 0 for empty / single-candle input (no span possible)', () => {
    assert.equal(computeDataSpanDays([]), 0);
    assert.equal(computeDataSpanDays([{ time: 1000 }]), 0);
  });

  it('computes span correctly for two candles spanning 30 days', () => {
    const start = Date.UTC(2026, 0, 1);
    const candles = [{ time: start }, { time: start + 30 * MS_PER_DAY }];
    assert.equal(computeDataSpanDays(candles), 30);
  });

  it('computes span using FIRST and LAST regardless of intermediate gaps', () => {
    const start = Date.UTC(2026, 0, 1);
    const candles = [
      { time: start },
      { time: start + 5 * MS_PER_DAY },          // gap-tolerant — intermediate values ignored
      { time: start + 90 * MS_PER_DAY },
    ];
    assert.equal(computeDataSpanDays(candles), 90);
  });

  it('returns fractional days for sub-day spans', () => {
    const start = Date.UTC(2026, 0, 1);
    const candles = [{ time: start }, { time: start + 12 * 60 * 60 * 1000 }];
    assert.equal(computeDataSpanDays(candles), 0.5);
  });

  it('returns 0 if last <= first (defensive — should never happen with sorted candles)', () => {
    const t = 1000;
    assert.equal(computeDataSpanDays([{ time: t }, { time: t }]), 0);
    assert.equal(computeDataSpanDays([{ time: 1000 }, { time: 500 }]), 0);
  });

  it('exports a 90-day default that matches batch script + UI defaults', () => {
    // Ensures DEFAULT_MIN_DATA_SPAN_DAYS stays in lockstep with the 90 used in batch CLI
    // and the Browse panel's filter default. If anyone changes one, this test pins the rest.
    assert.equal(DEFAULT_MIN_DATA_SPAN_DAYS, 90);
  });
});

describe('formatPct', () => {
  // The PENGU bug — toFixed(1) silently returned scientific notation for |x| >= 1e21,
  // which is how "+3.5907180999821344e+26%" leaked onto the leaderboard for poisoned data.
  it('compacts the PENGU bug case (3.59e+26) to a readable suffix', () => {
    const out = formatPct(3.5907180999821344e+26);
    assert.ok(!/e\+/.test(out), `must not contain scientific notation: ${out}`);
    assert.ok(out.endsWith('T%'), `expected T-suffix for 1e26 magnitude, got ${out}`);
  });

  it('compacts WMATIC-scale values (2.98e16) without scientific', () => {
    const out = formatPct(29827714114558880);
    assert.ok(!/e\+/.test(out), `no scientific allowed: ${out}`);
    assert.ok(out.endsWith('T%'));
  });

  it('uses suffix tiers: T (1e12), B (1e9), M (1e6), K (1e4) — and full notation below', () => {
    assert.equal(formatPct(2_500_000_000_000), '+2.5T%');
    assert.equal(formatPct(7_400_000_000),     '+7.4B%');
    assert.equal(formatPct(1_500_000),         '+1.5M%');
    assert.equal(formatPct(45_000),            '+45.0K%');
    assert.equal(formatPct(1_234),             '+1234.0%');         // below K threshold
    assert.equal(formatPct(12.345),            '+12.3%');
  });

  it('handles zero and small values', () => {
    assert.equal(formatPct(0),     '+0.0%');
    assert.equal(formatPct(0.001), '+0.0%');
  });

  it('handles negative values with proper sign (using U+2212 minus)', () => {
    const out = formatPct(-50.5);
    assert.ok(out.startsWith('−'), `expected − prefix, got ${out[0]}`);
    assert.equal(out, '−50.5%');
  });

  it('compacts large negatives the same way as positives', () => {
    assert.equal(formatPct(-2_500_000), '−2.5M%');
  });

  it('handles Infinity / -Infinity / NaN gracefully', () => {
    assert.equal(formatPct(Infinity), '+∞%');
    assert.equal(formatPct(-Infinity), '−∞%');
    assert.equal(formatPct(NaN), 'NaN%');
  });

  it('respects custom digit precision', () => {
    assert.equal(formatPct(1234, 0), '+1234%');
    assert.equal(formatPct(1234, 3), '+1234.000%');
  });
});

describe('pickCanonicalSource', () => {
  // Reproduces the WMATIC scenario: OKX has more rows but Jupiter has truer prices. We must
  // pick Jupiter EVEN though OKX appears first in the candidate list.
  it('picks Jupiter over OKX even when OKX is listed first', () => {
    assert.equal(pickCanonicalSource(['okx', 'jupiter_v2']), 'jupiter_v2');
  });

  it('picks Jupiter v2 over legacy jupiter when both present', () => {
    assert.equal(pickCanonicalSource(['jupiter', 'jupiter_v2']), 'jupiter_v2');
  });

  it('falls back to OKX when no Jupiter source available', () => {
    assert.equal(pickCanonicalSource(['kraken', 'okx', 'live']), 'okx');
  });

  it('returns null on empty input', () => {
    assert.equal(pickCanonicalSource([]), null);
  });

  it('handles a single-source list', () => {
    assert.equal(pickCanonicalSource(['geckoterminal']), 'geckoterminal');
  });
});
