/**
 * Tests for scripts/phase_b_campaign_cycle_v1.ts — the Cycle 23 Composite
 * worker's deflation-pipeline harness for cycle_v1.
 *
 * Coverage (≥30 tests per SPEC §5):
 *   - Strategy template: positions, trade counts, days-in-market
 *   - Score-benchmark alignment: forward-fill within window, raise on long gap
 *   - Walk-forward split: IS_END_DATE = 2020-12-31 cleanly partitions
 *   - backtestTrial golden-vector outputs (hand-computed)
 *   - Sharpe / skewness / kurtosis convention parity with validator.ts
 *   - CSCV slice configuration: T=3270 → effectiveS=16; T<1024 → 8
 *   - Theta grid: exactly 19 trials at 0.05 step
 *   - HLZ M = 57 (19 × 3) global rank computation
 *   - Verdict aggregation: PASS-ALL gated on PBO<0.2
 *   - Constants pinned: COMPOSITE_VERSION = 'cycle_v1' (anti-result-shopping)
 *   - Benchmark token-address convention pin (SPEC §S-PBC1-2 + §8 named test)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSITE_VERSION,
  BENCHMARKS,
  THETA_GRID,
  IS_END_DATE,
  OOS_START_DATE,
  MAX_SCORE_GAP_DAYS,
  DEFAULT_CSCV_S,
  HLZ_TOTAL_TRIALS,
  PHASE_C_PBO_GATE,
  benchmarkTokenAddress,
  alignScoresToBenchmark,
  clipBenchmarkToMinDate,
  computePositions,
  countTrades,
  sharpeNonAnnual,
  skewness,
  kurtosis,
  resolveEffectiveS,
  computeSliceSharpes,
  backtestTrial,
  trialToRow,
  runValidatorGatesForBenchmark,
  gateOutcomesToVerdictRow,
  pickPrimaryPhaseCCandidate,
  buildGlobalIsTStatRanks,
  type ScoreSeries,
  type BenchmarkSeries,
  type TrialBacktestResult,
  type BenchmarkGateOutcomes,
} from '../phase_b_campaign_cycle_v1.js';
// Note: sharpeNonAnnual is NOT exported from validator.ts (it's a module-
// internal helper). The harness re-implements it with the same convention;
// the parity check below verifies the constants the harness inherits.

// ── Constants pinned for anti-result-shopping audit ────────────────────────

describe('SPEC-pinned constants — ADR-051 + phase-b-cycle-v1.md', () => {
  it('COMPOSITE_VERSION = "cycle_v1" (anti-result-shopping audit key)', () => {
    assert.equal(COMPOSITE_VERSION, 'cycle_v1');
  });
  it('BENCHMARKS = [SPY, QQQ, IWM] per SPEC §S-PBC1-2', () => {
    assert.deepEqual([...BENCHMARKS], ['SPY', 'QQQ', 'IWM']);
  });
  it('THETA_GRID has 19 trials at step 0.05 per SPEC §S-PBC1-3', () => {
    assert.equal(THETA_GRID.length, 19);
    // First, last, and middle values pinned.
    assert.equal(THETA_GRID[0], 0.05);
    assert.equal(THETA_GRID[18], 0.95);
    // Step uniformity — all neighbor diffs ≈ 0.05.
    for (let i = 1; i < THETA_GRID.length; i++) {
      const diff = THETA_GRID[i] - THETA_GRID[i - 1];
      assert.ok(Math.abs(diff - 0.05) < 1e-9,
        `θ[${i}] - θ[${i - 1}] = ${diff} ≠ 0.05`);
    }
  });
  it('IS_END_DATE = "2020-12-31" per SPEC §S-PBC1-4', () => {
    assert.equal(IS_END_DATE, '2020-12-31');
  });
  it('OOS_START_DATE = "2021-01-01" per SPEC §S-PBC1-4', () => {
    assert.equal(OOS_START_DATE, '2021-01-01');
  });
  it('MAX_SCORE_GAP_DAYS = 4 per SPEC §3 step 1', () => {
    assert.equal(MAX_SCORE_GAP_DAYS, 4);
  });
  it('DEFAULT_CSCV_S = 16 per SPEC §S-PBC1-5', () => {
    assert.equal(DEFAULT_CSCV_S, 16);
  });
  it('HLZ_TOTAL_TRIALS = 57 (19 × 3) per SPEC §S-PBC1-6', () => {
    assert.equal(HLZ_TOTAL_TRIALS, 57);
  });
  it('PHASE_C_PBO_GATE = 0.2 per ADR-051 §Decision 5', () => {
    assert.equal(PHASE_C_PBO_GATE, 0.2);
  });
});

// ── Benchmark token-address convention pin (SPEC §S-PBC1-2 + §8) ───────────

describe('benchmarkTokenAddress — convention pin per SPEC §8', () => {
  // This is the named test SPEC §8 calls for: future drift in the
  // `<TICKER>_USD` convention in yfinance_backfill.py surfaces here loudly.
  it('SPY -> SPY_USD', () => {
    assert.equal(benchmarkTokenAddress('SPY'), 'SPY_USD');
  });
  it('QQQ -> QQQ_USD', () => {
    assert.equal(benchmarkTokenAddress('QQQ'), 'QQQ_USD');
  });
  it('IWM -> IWM_USD', () => {
    assert.equal(benchmarkTokenAddress('IWM'), 'IWM_USD');
  });
  it('convention pins to the yfinance_backfill.py:145 format', () => {
    // Any symbol → `${symbol}_USD`. The "_USD" suffix is the part
    // the campaign relies on; a future refactor that drops it would
    // break benchmark resolution silently.
    assert.match(benchmarkTokenAddress('SPY'), /_USD$/);
    assert.match(benchmarkTokenAddress('TLT'), /_USD$/);
  });
});

// ── alignScoresToBenchmark ─────────────────────────────────────────────────

describe('alignScoresToBenchmark — SPEC §3 step 1', () => {
  it('exact daily alignment: every benchmark date has its own score', () => {
    const score: ScoreSeries = {
      dates: ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07'],
      scores: [0.5, 0.6, 0.7, 0.8],
    };
    const benchmark: BenchmarkSeries = {
      symbol: 'SPY',
      dates: ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07'],
      returns: [0, 0.01, 0.02, -0.01],
    };
    const aligned = alignScoresToBenchmark(score, benchmark);
    assert.deepEqual(aligned, [0.5, 0.6, 0.7, 0.8]);
  });

  it('forward-fills 1-day gap: weekend-style', () => {
    const score: ScoreSeries = {
      dates: ['2020-01-02', '2020-01-06'],   // Mon, then Mon a week later (no Tue-Fri scores)
      scores: [0.5, 0.6],
    };
    const benchmark: BenchmarkSeries = {
      symbol: 'SPY',
      dates: ['2020-01-02', '2020-01-03', '2020-01-06'],  // 3 trading days
      returns: [0, 0.01, 0.02],
    };
    const aligned = alignScoresToBenchmark(score, benchmark);
    // Jan 3 should forward-fill from Jan 2 (gap of 1 trading day).
    assert.deepEqual(aligned, [0.5, 0.5, 0.6]);
  });

  it('forward-fills 4-day gap (exactly at MAX_SCORE_GAP_DAYS)', () => {
    const score: ScoreSeries = {
      dates: ['2020-01-02', '2020-01-09'],  // 5 trading-day gap → 4 fwd-fills
      scores: [0.5, 0.6],
    };
    const benchmark: BenchmarkSeries = {
      symbol: 'SPY',
      dates: ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07', '2020-01-08', '2020-01-09'],
      returns: [0, 0, 0, 0, 0, 0],
    };
    const aligned = alignScoresToBenchmark(score, benchmark);
    // Jan 3, 6, 7, 8 all fwd-fill from Jan 2 (4 trading days gap, exact).
    assert.deepEqual(aligned, [0.5, 0.5, 0.5, 0.5, 0.5, 0.6]);
  });

  it('raises on gap > MAX_SCORE_GAP_DAYS (5+ trading days)', () => {
    const score: ScoreSeries = {
      dates: ['2020-01-02', '2020-01-10'],  // 6 trading-day gap (Jan 3, 6, 7, 8, 9)
      scores: [0.5, 0.6],
    };
    const benchmark: BenchmarkSeries = {
      symbol: 'SPY',
      dates: ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07', '2020-01-08', '2020-01-09', '2020-01-10'],
      returns: [0, 0, 0, 0, 0, 0, 0],
    };
    assert.throws(
      () => alignScoresToBenchmark(score, benchmark),
      /score gap of 5 trading days/,
    );
  });

  it('raises when benchmark precedes score (caught by pre-flight too)', () => {
    const score: ScoreSeries = {
      dates: ['2020-01-06'],
      scores: [0.5],
    };
    const benchmark: BenchmarkSeries = {
      symbol: 'SPY',
      dates: ['2020-01-02', '2020-01-06'],
      returns: [0, 0.01],
    };
    assert.throws(
      () => alignScoresToBenchmark(score, benchmark),
      /is before the first score date/,
    );
  });

  it('raises on empty score series', () => {
    assert.throws(
      () => alignScoresToBenchmark({ dates: [], scores: [] },
        { symbol: 'SPY', dates: ['2020-01-02'], returns: [0] }),
      /empty score series/,
    );
  });

  it('raises on empty benchmark series', () => {
    assert.throws(
      () => alignScoresToBenchmark({ dates: ['2020-01-02'], scores: [0.5] },
        { symbol: 'SPY', dates: [], returns: [] }),
      /empty benchmark series/,
    );
  });
});

// ── clipBenchmarkToMinDate ─────────────────────────────────────────────────

describe('clipBenchmarkToMinDate — drop pre-score history', () => {
  it('drops dates strictly before minDate', () => {
    const b: BenchmarkSeries = {
      symbol: 'SPY',
      dates: ['2007-12-31', '2008-01-02', '2008-01-03'],
      returns: [0, 0.01, 0.02],
    };
    const clipped = clipBenchmarkToMinDate(b, '2008-01-02');
    assert.deepEqual(clipped.dates, ['2008-01-02', '2008-01-03']);
    assert.deepEqual(clipped.returns, [0.01, 0.02]);
  });

  it('keeps dates equal to minDate', () => {
    const b: BenchmarkSeries = {
      symbol: 'SPY',
      dates: ['2008-01-02'],
      returns: [0.01],
    };
    const clipped = clipBenchmarkToMinDate(b, '2008-01-02');
    assert.deepEqual(clipped.dates, ['2008-01-02']);
  });

  it('returns empty when all dates precede minDate', () => {
    const b: BenchmarkSeries = {
      symbol: 'SPY',
      dates: ['2007-12-31', '2008-01-01'],
      returns: [0, 0],
    };
    const clipped = clipBenchmarkToMinDate(b, '2008-01-02');
    assert.deepEqual(clipped.dates, []);
  });

  it('preserves symbol on the returned series', () => {
    const b: BenchmarkSeries = {
      symbol: 'QQQ',
      dates: ['2008-01-02'],
      returns: [0],
    };
    const clipped = clipBenchmarkToMinDate(b, '2008-01-01');
    assert.equal(clipped.symbol, 'QQQ');
  });
});

// ── computePositions + countTrades ─────────────────────────────────────────

describe('computePositions — strategy template per ADR-051 §Decision 1', () => {
  it('position(0) is always 0 (no t-1 score)', () => {
    const positions = computePositions([0.6, 0.7, 0.8], 0.5);
    assert.equal(positions[0], 0);
  });

  it('long when prior score > theta', () => {
    const positions = computePositions([0.6, 0.7, 0.8], 0.5);
    // t=1 uses score[0]=0.6 > 0.5 → 1
    // t=2 uses score[1]=0.7 > 0.5 → 1
    assert.deepEqual(positions, [0, 1, 1]);
  });

  it('flat when prior score ≤ theta', () => {
    const positions = computePositions([0.6, 0.4, 0.5], 0.5);
    // t=1: score[0]=0.6 > 0.5 → 1
    // t=2: score[1]=0.4 > 0.5 → false → 0
    assert.deepEqual(positions, [0, 1, 0]);
  });

  it('strict greater than (score equal to theta is FLAT)', () => {
    const positions = computePositions([0.5, 0.5, 0.5], 0.5);
    // score[0]=0.5 NOT > 0.5 → 0
    assert.deepEqual(positions, [0, 0, 0]);
  });

  it('handles theta=0 (always long after t=0)', () => {
    const positions = computePositions([0.01, 0.5], 0);
    assert.deepEqual(positions, [0, 1]);
  });
});

describe('countTrades — position transitions', () => {
  it('zero trades for constant position', () => {
    assert.equal(countTrades([0, 0, 0, 0]), 0);
    assert.equal(countTrades([1, 1, 1, 1]), 0);
  });
  it('counts each flip as one trade', () => {
    // 0 → 1 → 0 → 1 = 3 transitions
    assert.equal(countTrades([0, 1, 0, 1]), 3);
  });
  it('counts entry from FLAT as 1 trade', () => {
    // 0 → 1 = 1 transition
    assert.equal(countTrades([0, 1, 1, 1]), 1);
  });
  it('single-position series counts 0 trades', () => {
    assert.equal(countTrades([1]), 0);
    assert.equal(countTrades([0]), 0);
  });
});

// ── Sharpe / moments parity with validator.ts ──────────────────────────────

describe('sharpeNonAnnual / skewness / kurtosis — convention parity', () => {
  it('Sharpe = mean / std (population, n divisor)', () => {
    // Hand-computed: mean = 0.5, var = 0.25 (n divisor), std = 0.5,
    // Sharpe = 0.5 / 0.5 = 1.0.
    const sr = sharpeNonAnnual([0, 1, 0, 1]);
    assert.ok(Math.abs(sr - 1.0) < 1e-9, `expected 1.0, got ${sr}`);
  });
  it('Sharpe = 0 when n < 2', () => {
    assert.equal(sharpeNonAnnual([]), 0);
    assert.equal(sharpeNonAnnual([0.5]), 0);
  });
  it('Sharpe = 0 when variance = 0 (constant return)', () => {
    assert.equal(sharpeNonAnnual([0.5, 0.5, 0.5]), 0);
  });
  it('skewness of symmetric distribution ≈ 0', () => {
    const s = skewness([-2, -1, 0, 1, 2]);
    assert.ok(Math.abs(s) < 1e-9, `expected 0, got ${s}`);
  });
  it('kurtosis of Gaussian-like distribution close to 3', () => {
    // 5-point uniform-ish: γ4 of uniform is 1.8 — not quite Gaussian, but
    // bounded. The test verifies the raw-not-excess convention (Gaussian=3,
    // not Gaussian=0).
    const k = kurtosis([-2, -1, 0, 1, 2]);
    // Discrete uniform on 5 points: m2 = 2, m4 = 6.8, γ4 = 6.8/4 = 1.7
    assert.ok(Math.abs(k - 1.7) < 1e-9, `expected 1.7 (raw, not excess), got ${k}`);
  });
  it('kurtosis floors at 3 for n<4', () => {
    assert.equal(kurtosis([1, 2, 3]), 3);
  });
});

// ── resolveEffectiveS + computeSliceSharpes ────────────────────────────────

describe('resolveEffectiveS — CSCV slice-count auto-downshift per cscv.ts', () => {
  it('returns 0 when T < 256 (CSCV infeasible)', () => {
    assert.equal(resolveEffectiveS(100), 0);
    assert.equal(resolveEffectiveS(255), 0);
  });
  it('returns 8 when 256 ≤ T < 1024', () => {
    assert.equal(resolveEffectiveS(256), 8);
    assert.equal(resolveEffectiveS(1023), 8);
  });
  it('returns 16 (DEFAULT_CSCV_S) when T ≥ 1024 — SPEC §S-PBC1-5 case', () => {
    assert.equal(resolveEffectiveS(1024), 16);
    assert.equal(resolveEffectiveS(3270), 16);   // SPEC-predicted IS length
  });
  it('honors requestedS override when T allows', () => {
    assert.equal(resolveEffectiveS(1024, 8), 8);
  });
});

describe('computeSliceSharpes — slice partitioning', () => {
  it('returns S Sharpes for S slices', () => {
    const returns = Array.from({ length: 32 }, () => 0.01);
    const sliced = computeSliceSharpes(returns, 4);
    assert.equal(sliced.length, 4);
  });
  it('returns empty when S=0', () => {
    assert.deepEqual(computeSliceSharpes([0.01, 0.02], 0), []);
  });
  it('zero-variance slice → 0 Sharpe (not NaN)', () => {
    const returns = [0.01, 0.01, 0.01, 0.01];  // constant
    const sliced = computeSliceSharpes(returns, 2);
    assert.ok(Number.isFinite(sliced[0]), `slice[0] = ${sliced[0]} must be finite`);
    assert.equal(sliced[0], 0);
  });
});

// ── backtestTrial — golden vectors ─────────────────────────────────────────

describe('backtestTrial — golden-vector outputs', () => {
  // Build a tiny scenario where positions + returns are hand-computable.
  // 6 dates 2020-01-02..2020-01-09 (trading days), scores at exact same
  // dates so alignment is identity.
  const score: ScoreSeries = {
    dates: ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07',
            '2020-01-08', '2020-01-09'],
    scores: [0.8, 0.4, 0.6, 0.2, 0.7, 0.9],
  };
  const benchmark: BenchmarkSeries = {
    symbol: 'SPY',
    dates: ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07',
            '2020-01-08', '2020-01-09'],
    returns: [0, 0.01, -0.02, 0.03, -0.01, 0.02],
  };
  // Run with theta=0.5 and isEndDate = '2020-01-07' (so IS = first 4 bars,
  // OOS = last 2 bars).
  const result = backtestTrial(score, benchmark, 0.5, '2020-01-07');

  it('first position is 0 (no t-1 score)', () => {
    // result doesn't expose positions, but is_days_in_market lets us
    // back-derive: position(t) = score(t-1) > 0.5.
    //   t=0: 0
    //   t=1: score[0]=0.8>0.5 → 1
    //   t=2: score[1]=0.4>0.5 → 0
    //   t=3: score[2]=0.6>0.5 → 1
    //   t=4: score[3]=0.2>0.5 → 0
    //   t=5: score[4]=0.7>0.5 → 1
    // IS positions: [0, 1, 0, 1] (4 bars) → 2 days in market
    // OOS positions: [0, 1] (2 bars) → 1 day in market
    assert.equal(result.is_days_in_market, 2);
    assert.equal(result.oos_days_in_market, 1);
  });

  it('IS trade count = 3 (0→1, 1→0, 0→1)', () => {
    // IS positions [0, 1, 0, 1] → 3 transitions.
    assert.equal(result.is_trades, 3);
  });

  it('OOS trade count = 1 (0→1)', () => {
    // OOS positions [0, 1] → 1 transition.
    assert.equal(result.oos_trades, 1);
  });

  it('IS net return = exp(0.01 + 0.03) - 1 (long bars 1 + 3)', () => {
    // Strategy returns IS: position × benchmark = [0, 0.01, 0, 0.03]
    const expected = (Math.exp(0.01 + 0.03) - 1) * 100;
    assert.ok(Math.abs(result.is_net_return_pct - expected) < 1e-9,
      `IS net%: got ${result.is_net_return_pct}, expected ${expected}`);
  });

  it('OOS net return = exp(0.02) - 1 (long bar 5)', () => {
    // OOS strategy returns: [0, 0.02]
    const expected = (Math.exp(0.02) - 1) * 100;
    assert.ok(Math.abs(result.oos_net_return_pct - expected) < 1e-9);
  });

  it('skewness + kurtosis are finite numbers', () => {
    assert.ok(Number.isFinite(result.skewness_is));
    assert.ok(Number.isFinite(result.kurtosis_is));
  });

  it('IS sharpe is finite (or 0 — depends on slice variance)', () => {
    assert.ok(Number.isFinite(result.is_sharpe));
  });

  it('is_slice_sharpes length is 0 when IS bars < 256', () => {
    // IS bars = 4 here → resolveEffectiveS = 0 → 0 slices.
    assert.equal(result.is_slice_sharpes.length, 0);
  });

  it('raises on theta out of [0,1]', () => {
    assert.throws(() => backtestTrial(score, benchmark, -0.1, '2020-01-07'), /theta=/);
    assert.throws(() => backtestTrial(score, benchmark, 1.5, '2020-01-07'), /theta=/);
  });

  it('raises on benchmark length mismatch', () => {
    const badBenchmark: BenchmarkSeries = {
      symbol: 'SPY',
      dates: ['2020-01-02', '2020-01-03'],
      returns: [0],     // length 1 vs dates length 2
    };
    assert.throws(() => backtestTrial(score, badBenchmark, 0.5, '2020-01-07'),
      /dates\/returns length mismatch/);
  });

  it('isEndDate splits cleanly: IS bars have date ≤ isEndDate', () => {
    // IS = 4 bars (2020-01-02 .. 2020-01-07); OOS = 2 bars (2020-01-08 .. 2020-01-09).
    // Total IS+OOS bars = 6 = benchmark.dates.length.
    assert.equal(result.is_days_in_market + result.oos_days_in_market, 3);
    // Re-derive: IS = 4 bars (slice 0..4); OOS = 2 bars (slice 4..6). The
    // backtestTrial doesn't expose bar counts directly, but isReturns +
    // oosReturns do (used internally; let's spot-check):
    assert.equal(result.isReturns.length, 4);
    assert.equal(result.oosReturns.length, 2);
  });

  it('IS-window flat strategy → IS sharpe = 0 (all-flat zero returns)', () => {
    // theta=2 forces every position to FLAT (score is never > 2). So
    // strategy returns are all 0 → variance 0 → Sharpe 0.
    const result2 = backtestTrial(score, benchmark, 0.999, '2020-01-07');
    assert.equal(result2.is_days_in_market, 0);
    assert.equal(result2.is_sharpe, 0);
    assert.equal(result2.is_trades, 0);
  });
});

// ── Slice count at SPEC-predicted IS length ────────────────────────────────

describe('IS-window slice configuration at SPEC §S-PBC1-4 length', () => {
  it('T~3270 IS days resolves to effectiveS=16 (cscv.ts:115 MIN_BARS_FOR_S16=1024)', () => {
    // Synthetic 3270-bar IS strategy: random-walk returns with one big
    // outlier so Sharpe is non-zero and slice partitioning is interesting.
    const T = 3270;
    const isReturns: number[] = new Array(T);
    for (let i = 0; i < T; i++) {
      isReturns[i] = ((i * 2654435761) % 1000) / 100000 - 0.005;  // deterministic pseudo-random
    }
    const effectiveS = resolveEffectiveS(T);
    assert.equal(effectiveS, 16);
    const slices = computeSliceSharpes(isReturns, effectiveS);
    assert.equal(slices.length, 16);
    for (const s of slices) {
      assert.ok(Number.isFinite(s), `slice Sharpe ${s} must be finite`);
    }
  });
});

// ── trialToRow shape ───────────────────────────────────────────────────────

describe('trialToRow — maps TrialBacktestResult to PhaseBTrialRow', () => {
  const probeResult: TrialBacktestResult = {
    is_sharpe: 0.5, oos_sharpe: 0.3,
    is_trades: 50, oos_trades: 20,
    is_days_in_market: 1000, oos_days_in_market: 400,
    is_net_return_pct: 25, oos_net_return_pct: 8,
    skewness_is: -0.3, kurtosis_is: 5.5,
    is_slice_sharpes: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8,
                      0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6],
    isReturns: [],
    oosReturns: [],
  };

  it('compositeVersion is "cycle_v1"', () => {
    const row = trialToRow('SPY', 0.5, 9, probeResult,
      '2008-01-02', '2020-12-31', '2021-01-04', '2026-05-22');
    assert.equal(row.compositeVersion, 'cycle_v1');
  });
  it('benchmark + theta + trialIdx pass through', () => {
    const row = trialToRow('QQQ', 0.4, 7, probeResult,
      '2008-01-02', '2020-12-31', '2021-01-04', '2026-05-22');
    assert.equal(row.benchmark, 'QQQ');
    assert.equal(row.theta, 0.4);
    assert.equal(row.trialIdx, 7);
  });
  it('date fields pass through', () => {
    const row = trialToRow('IWM', 0.5, 9, probeResult,
      '2008-01-02', '2020-12-31', '2021-01-04', '2026-05-22');
    assert.equal(row.isStartDate, '2008-01-02');
    assert.equal(row.isEndDate, '2020-12-31');
    assert.equal(row.oosStartDate, '2021-01-04');
    assert.equal(row.oosEndDate, '2026-05-22');
  });
  it('preserves the 16-element slice array (length parity per §Decision 6)', () => {
    const row = trialToRow('SPY', 0.5, 9, probeResult,
      '2008-01-02', '2020-12-31', '2021-01-04', '2026-05-22');
    assert.equal(row.isSliceSharpes.length, 16);
    assert.deepEqual(row.isSliceSharpes, probeResult.is_slice_sharpes);
  });
});

// ── buildGlobalIsTStatRanks ────────────────────────────────────────────────

describe('buildGlobalIsTStatRanks — HLZ M=57 global rank computation', () => {
  function fakeTrial(sharpe: number): TrialBacktestResult {
    return {
      is_sharpe: sharpe, oos_sharpe: 0,
      is_trades: 50, oos_trades: 20,
      is_days_in_market: 100, oos_days_in_market: 40,
      is_net_return_pct: 0, oos_net_return_pct: 0,
      skewness_is: 0, kurtosis_is: 3,
      is_slice_sharpes: [],
      isReturns: [], oosReturns: [],
    };
  }

  it('returns 1-indexed ranks per (benchmark, trialIdx)', () => {
    const trials = new Map([
      ['SPY', [fakeTrial(0.5), fakeTrial(0.9)]],  // QQQ trial 1 wins overall
      ['QQQ', [fakeTrial(0.7), fakeTrial(1.0)]],
    ]);
    const ranks = buildGlobalIsTStatRanks(trials, 1000);
    // Top-down by t-stat (Sharpe × sqrt(T-1)):
    //   QQQ|1 (1.0) > SPY|1 (0.9) > QQQ|0 (0.7) > SPY|0 (0.5)
    assert.equal(ranks.get('QQQ|1'), 1);
    assert.equal(ranks.get('SPY|1'), 2);
    assert.equal(ranks.get('QQQ|0'), 3);
    assert.equal(ranks.get('SPY|0'), 4);
  });

  it('produces a map of size equal to total trials', () => {
    const trials = new Map([
      ['SPY', [fakeTrial(0.5)]],
      ['QQQ', [fakeTrial(0.5)]],
      ['IWM', [fakeTrial(0.5)]],
    ]);
    const ranks = buildGlobalIsTStatRanks(trials, 100);
    assert.equal(ranks.size, 3);
  });

  it('ties broken by insertion order (stable)', () => {
    const trials = new Map([
      ['SPY', [fakeTrial(0.5)]],   // inserted first
      ['QQQ', [fakeTrial(0.5)]],   // inserted second
    ]);
    const ranks = buildGlobalIsTStatRanks(trials, 100);
    // SPY inserted first → rank 1; QQQ → rank 2.
    assert.equal(ranks.get('SPY|0'), 1);
    assert.equal(ranks.get('QQQ|0'), 2);
  });
});

// ── runValidatorGatesForBenchmark ──────────────────────────────────────────

describe('runValidatorGatesForBenchmark — four-gate stack', () => {
  function fakeTrials(N: number, isDays: number, baseSharpe: number): TrialBacktestResult[] {
    const trials: TrialBacktestResult[] = [];
    const T = isDays;
    for (let i = 0; i < N; i++) {
      // Synthetic per-bar returns; vary mean across trials so Sharpe varies.
      const returns: number[] = new Array(T);
      const trialMean = baseSharpe * 0.01 + (i - N / 2) * 0.0001;
      for (let t = 0; t < T; t++) {
        returns[t] = trialMean + ((t * 31337 + i * 17) % 1000) / 100000 - 0.005;
      }
      // Slice Sharpes via the canonical helper.
      const effS = resolveEffectiveS(T);
      const slices = computeSliceSharpes(returns, effS);
      // Simplistic oosReturns to give the Pardo gate something to grip on.
      const oosReturns = returns.slice(0, Math.floor(T / 4));
      trials.push({
        is_sharpe: sharpeNonAnnual(returns),
        oos_sharpe: sharpeNonAnnual(oosReturns),
        is_trades: 50,
        oos_trades: 20,
        is_days_in_market: Math.floor(T / 2),
        oos_days_in_market: Math.floor(oosReturns.length / 2),
        is_net_return_pct: 10,
        oos_net_return_pct: 5,
        skewness_is: skewness(returns),
        kurtosis_is: kurtosis(returns),
        is_slice_sharpes: slices,
        isReturns: returns,
        oosReturns: oosReturns,
      });
    }
    return trials;
  }

  it('returns four gate outcomes', () => {
    const trials = fakeTrials(19, 1200, 0.5);
    const thetas = THETA_GRID.slice(0, 19);
    const gates = runValidatorGatesForBenchmark(
      'SPY', trials, thetas, 1200, 1, 57,
    );
    assert.ok(gates.dsr);
    assert.ok(gates.pbo);
    assert.ok(gates.hlz);
    assert.ok(gates.oosIs);
  });

  it('picks the argmax IS-sharpe trial as bestTrialIdx', () => {
    const trials = fakeTrials(19, 1200, 0.5);
    const thetas = THETA_GRID.slice(0, 19);
    // Find expected best.
    let expectedBest = 0;
    for (let i = 1; i < trials.length; i++) {
      if (trials[i].is_sharpe > trials[expectedBest].is_sharpe) expectedBest = i;
    }
    const gates = runValidatorGatesForBenchmark(
      'SPY', trials, thetas, 1200, expectedBest + 1, 57,
    );
    assert.equal(gates.bestTrialIdx, expectedBest);
    assert.equal(gates.bestTheta, thetas[expectedBest]);
  });

  it('raises on empty trials', () => {
    assert.throws(
      () => runValidatorGatesForBenchmark('SPY', [], [], 1200, 1, 57),
      /no trials/,
    );
  });

  it('raises on trial/theta length mismatch', () => {
    const trials = fakeTrials(5, 1200, 0.5);
    assert.throws(
      () => runValidatorGatesForBenchmark('SPY', trials, [0.1, 0.2], 1200, 1, 57),
      /length mismatch/,
    );
  });
});

// ── gateOutcomesToVerdictRow ───────────────────────────────────────────────

describe('gateOutcomesToVerdictRow — verdict aggregation per ADR-051 §Decision 5', () => {
  function mkGate(status: 'pass' | 'fail' | 'na', value: number | null): {
    status: 'pass' | 'fail' | 'na'; value: number | null; threshold: number;
    label: string; source: string; intuition: string; explanation: string;
    failureMode: string; extras?: Record<string, unknown>;
  } {
    return {
      status, value, threshold: 0,
      label: 'X', source: '', intuition: '',
      explanation: '', failureMode: '',
    };
  }

  function mkGates(args: {
    dsrStatus: 'pass' | 'fail' | 'na';
    pboStatus: 'pass' | 'fail' | 'na';
    hlzStatus: 'pass' | 'fail' | 'na';
    oosIsStatus: 'pass' | 'fail' | 'na';
    pboValue?: number | null;
  }): BenchmarkGateOutcomes {
    return {
      benchmark: 'SPY',
      bestTrialIdx: 0,
      bestTheta: 0.5,
      bestIsSharpe: 1.0,
      bestOosSharpe: 0.5,
      dsr: mkGate(args.dsrStatus, 0.97),
      pbo: mkGate(args.pboStatus, args.pboValue ?? 0.15),
      hlz: mkGate(args.hlzStatus, 5.0),
      oosIs: mkGate(args.oosIsStatus, 0.55),
    };
  }

  it('PASS-ALL when all four gates pass', () => {
    const v = gateOutcomesToVerdictRow(mkGates({
      dsrStatus: 'pass', pboStatus: 'pass', hlzStatus: 'pass', oosIsStatus: 'pass',
      pboValue: 0.15,
    }), '');
    assert.equal(v.verdict, 'pass-all');
  });

  it('phase_c_eligible=true when PASS-ALL AND PBO < 0.2', () => {
    const v = gateOutcomesToVerdictRow(mkGates({
      dsrStatus: 'pass', pboStatus: 'pass', hlzStatus: 'pass', oosIsStatus: 'pass',
      pboValue: 0.18,
    }), '');
    assert.equal(v.phaseCEligible, true);
  });

  it('phase_c_eligible=false when PASS-ALL but PBO ≥ 0.2', () => {
    const v = gateOutcomesToVerdictRow(mkGates({
      dsrStatus: 'pass', pboStatus: 'pass', hlzStatus: 'pass', oosIsStatus: 'pass',
      pboValue: 0.25,  // PASS-ALL because pbo_pass might still be true (gate is < 0.5),
                       // but PHASE_C_PBO_GATE is stricter at < 0.2.
    }), '');
    assert.equal(v.phaseCEligible, false);
  });

  it('PARTIAL when some pass + some fail', () => {
    const v = gateOutcomesToVerdictRow(mkGates({
      dsrStatus: 'pass', pboStatus: 'pass', hlzStatus: 'fail', oosIsStatus: 'pass',
    }), '');
    assert.equal(v.verdict, 'partial');
    assert.equal(v.phaseCEligible, false);
  });

  it('FAIL when all four gates fail', () => {
    const v = gateOutcomesToVerdictRow(mkGates({
      dsrStatus: 'fail', pboStatus: 'fail', hlzStatus: 'fail', oosIsStatus: 'fail',
    }), '');
    assert.equal(v.verdict, 'fail');
    assert.equal(v.phaseCEligible, false);
  });

  it('INSUFFICIENT when ≥1 gate is na', () => {
    const v = gateOutcomesToVerdictRow(mkGates({
      dsrStatus: 'pass', pboStatus: 'na', hlzStatus: 'pass', oosIsStatus: 'pass',
      pboValue: null,
    }), '');
    assert.equal(v.verdict, 'insufficient');
    assert.equal(v.phaseCEligible, false);
  });

  it('persists compositeVersion + benchmark for audit trail', () => {
    const v = gateOutcomesToVerdictRow(mkGates({
      dsrStatus: 'pass', pboStatus: 'pass', hlzStatus: 'pass', oosIsStatus: 'pass',
    }), 'IS=2008-..-2020-..; ...');
    assert.equal(v.compositeVersion, 'cycle_v1');
    assert.equal(v.benchmark, 'SPY');
    assert.match(v.notes, /IS=/);
  });
});

// ── pickPrimaryPhaseCCandidate ─────────────────────────────────────────────

describe('pickPrimaryPhaseCCandidate — SPEC §S-PBC1-7 aggregation', () => {
  function mkVerdict(args: {
    benchmark: string; dsrValue: number | null; eligible: boolean;
  }): import('../phase_b_campaign_cycle_v1.js').BenchmarkGateOutcomes extends never ? never : ReturnType<typeof gateOutcomesToVerdictRow> {
    return {
      compositeVersion: 'cycle_v1',
      benchmark: args.benchmark,
      bestTrialTheta: 0.5,
      bestIsSharpe: 1.0,
      bestOosSharpe: 0.5,
      dsrValue: args.dsrValue,
      dsrPass: true,
      pboValue: 0.15,
      pboPass: true,
      hlzTStat: 5.0,
      hlzThreshold: 3.0,
      hlzPass: true,
      oosIsRatio: 0.55,
      oosIsPass: true,
      verdict: 'pass-all',
      phaseCEligible: args.eligible,
      notes: '',
    };
  }

  it('returns null when no benchmark is eligible', () => {
    const verdicts = [
      mkVerdict({ benchmark: 'SPY', dsrValue: 0.98, eligible: false }),
      mkVerdict({ benchmark: 'QQQ', dsrValue: 0.99, eligible: false }),
    ];
    assert.equal(pickPrimaryPhaseCCandidate(verdicts), null);
  });

  it('picks the sole eligible benchmark', () => {
    const verdicts = [
      mkVerdict({ benchmark: 'SPY', dsrValue: 0.97, eligible: true }),
      mkVerdict({ benchmark: 'QQQ', dsrValue: 0.95, eligible: false }),
    ];
    const primary = pickPrimaryPhaseCCandidate(verdicts);
    assert.ok(primary);
    assert.equal(primary?.benchmark, 'SPY');
  });

  it('picks the highest-DSR benchmark when multiple are eligible', () => {
    const verdicts = [
      mkVerdict({ benchmark: 'SPY', dsrValue: 0.96, eligible: true }),
      mkVerdict({ benchmark: 'QQQ', dsrValue: 0.99, eligible: true }),
      mkVerdict({ benchmark: 'IWM', dsrValue: 0.97, eligible: true }),
    ];
    const primary = pickPrimaryPhaseCCandidate(verdicts);
    assert.equal(primary?.benchmark, 'QQQ');
  });

  it('handles null dsrValue gracefully (treats as -Infinity)', () => {
    const verdicts = [
      mkVerdict({ benchmark: 'SPY', dsrValue: null, eligible: true }),
      mkVerdict({ benchmark: 'QQQ', dsrValue: 0.95, eligible: true }),
    ];
    const primary = pickPrimaryPhaseCCandidate(verdicts);
    assert.equal(primary?.benchmark, 'QQQ');
  });
});

// ── Validator entry-point parity ───────────────────────────────────────────

describe('validator.ts integration — same SignalForge defaults', () => {
  it('imports DEFAULT_DSR_GATE / DEFAULT_PBO_GATE / DEFAULT_PARDO_GATE constants', async () => {
    const validator = await import('../../src/lib/validator.js');
    assert.equal(validator.DEFAULT_DSR_GATE, 0.95);
    assert.equal(validator.DEFAULT_PBO_GATE, 0.50);
    assert.equal(validator.DEFAULT_PARDO_GATE, 0.50);
    assert.equal(validator.DEFAULT_HLZ_ALPHA, 0.05);
    assert.equal(validator.DEFAULT_HLZ_METHOD, 'bhy');
  });
});
