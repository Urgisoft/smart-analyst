/**
 * Tests for scripts/phase_b_campaign_vol_struct_v1.ts — the Cycle 24
 * Composite worker's deflation-pipeline harness for vol_struct_v1.
 *
 * Coverage (≥28 tests per SPEC §5):
 *   - SPEC-pinned constants (COMPOSITE_VERSION, BENCHMARKS, THETA_GRID, window dates).
 *   - normalCdf golden-vector parity (Φ(0)=0.5, Φ(±1), Φ(±2), max error <1e-6).
 *   - normalCdf monotonicity (z1 > z2 ⇒ Φ(z1) > Φ(z2)).
 *   - normalCdf domain edge cases (±Infinity, NaN).
 *   - loadScoreSeries shape: ascending dates + same-length scores +
 *     score values in [0, 1] (Φ-rescaled).
 *   - HLZ M = 57 (19 × 3) per SPEC §S-PBV1-7.
 *   - CSCV slice configuration: T ~2517 → effectiveS=16.
 *   - composite_version pin convention test on persisted rows.
 *   - Walk-forward split: IS_END_DATE = 2022-12-31 divides cleanly.
 *   - benchmarkTokenAddress re-export convention pin.
 *   - Validator request packaging: no perAssetSharpes; parametric Mertens path.
 *   - Verdict-aggregation rule (composite-version-agnostic re-test).
 *
 * The harness's `loadScoreSeries`, `runCampaign`, `persistCampaign`, and
 * the CLI entrypoint are I/O-bound (require live CH). Tests focus on the
 * pure-function deltas (normalCdf, composite_version pinning, constants)
 * and on the inherited cycle_v1 helpers re-asserted under the
 * vol_struct_v1 module surface.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSITE_VERSION,
  BENCHMARKS,
  THETA_GRID,
  WINDOW_START_DATE,
  IS_END_DATE,
  OOS_START_DATE,
  MAX_SCORE_GAP_DAYS,
  DEFAULT_CSCV_S,
  HLZ_TOTAL_TRIALS,
  PHASE_C_PBO_GATE,
  normalCdf,
  loadScoreSeries,
  benchmarkTokenAddress,
} from '../phase_b_campaign_vol_struct_v1.js';
import {
  // Pure cycle_v1 helpers used by vol_struct_v1 harness — re-tested under
  // the vol_struct_v1 import surface to pin the inheritance.
  resolveEffectiveS,
  computeSliceSharpes,
  backtestTrial,
  trialToRow,
  type ScoreSeries,
  type BenchmarkSeries,
  type TrialBacktestResult,
} from '../phase_b_campaign_cycle_v1.js';
import { COMPOSITE_VERSION as CYCLE_V1_COMPOSITE_VERSION } from '../phase_b_campaign_cycle_v1.js';

// ── SPEC-pinned constants — anti-result-shopping audit ─────────────────────

describe('SPEC-pinned constants — ADR-051 + phase-b-vol_struct_v1.md', () => {
  it('COMPOSITE_VERSION = "vol_struct_v1" (anti-result-shopping audit key)', () => {
    assert.equal(COMPOSITE_VERSION, 'vol_struct_v1');
  });
  it('BENCHMARKS = [SPY, QQQ, IWM] per SPEC §S-PBV1-3', () => {
    assert.deepEqual([...BENCHMARKS], ['SPY', 'QQQ', 'IWM']);
  });
  it('THETA_GRID has 19 trials at step 0.05 per SPEC §S-PBV1-4', () => {
    assert.equal(THETA_GRID.length, 19);
    assert.equal(THETA_GRID[0], 0.05);
    assert.equal(THETA_GRID[18], 0.95);
    for (let i = 1; i < THETA_GRID.length; i++) {
      const diff = THETA_GRID[i] - THETA_GRID[i - 1];
      assert.ok(Math.abs(diff - 0.05) < 1e-9,
        `θ[${i}] - θ[${i - 1}] = ${diff} ≠ 0.05`);
    }
  });
  it('WINDOW_START_DATE = "2013-01-03" per SPEC §S-PBV1-5', () => {
    assert.equal(WINDOW_START_DATE, '2013-01-03');
  });
  it('IS_END_DATE = "2022-12-31" per SPEC §S-PBV1-5', () => {
    assert.equal(IS_END_DATE, '2022-12-31');
  });
  it('OOS_START_DATE = "2023-01-03" per SPEC §S-PBV1-5', () => {
    assert.equal(OOS_START_DATE, '2023-01-03');
  });
  it('MAX_SCORE_GAP_DAYS = 4 (inherited from cycle_v1 per ADR-051 §Decision 3)', () => {
    assert.equal(MAX_SCORE_GAP_DAYS, 4);
  });
  it('DEFAULT_CSCV_S = 16 per SPEC §S-PBV1-6 (auto-downshift to 8 if T<1024)', () => {
    assert.equal(DEFAULT_CSCV_S, 16);
  });
  it('HLZ_TOTAL_TRIALS = 57 (19 × 3) per SPEC §S-PBV1-7', () => {
    assert.equal(HLZ_TOTAL_TRIALS, 57);
  });
  it('PHASE_C_PBO_GATE = 0.2 per ADR-051 §Decision 5', () => {
    assert.equal(PHASE_C_PBO_GATE, 0.2);
  });
  it('SPEC walk-forward window pinned to ≥10y IS (sufficient for CSCV S=16)', () => {
    // CSCV's MIN_BARS_FOR_S16 threshold is 1024 per cscv.ts:115. The
    // SPEC-pinned IS window is 2013-01-03 → 2022-12-31, which yields
    // ~2520 trading days on the US equity calendar. 2520 > 1024 ✓.
    // We can't reliably compute this without a calendar; the smoke
    // check is that IS_END_DATE comes ≥9 calendar years after
    // WINDOW_START_DATE.
    const start = new Date(WINDOW_START_DATE + 'T00:00:00Z').getTime();
    const end = new Date(IS_END_DATE + 'T00:00:00Z').getTime();
    const years = (end - start) / (1000 * 60 * 60 * 24 * 365.25);
    assert.ok(years >= 9.0,
      `IS window covers only ${years.toFixed(2)}y; SPEC requires ~10y for CSCV S=16`);
  });
});

// ── COMPOSITE_VERSION anti-shopping audit ──────────────────────────────────

describe('Composite-version pin — anti-shopping rule per ADR-051 §Decision 8', () => {
  it('vol_struct_v1 COMPOSITE_VERSION differs from cycle_v1\'s', () => {
    // Belt-and-suspenders: vol_struct_v1 must NEVER share its
    // composite_version with cycle_v1 (which would corrupt the
    // quantlab.phase_b_verdicts audit trail).
    assert.notEqual(COMPOSITE_VERSION, CYCLE_V1_COMPOSITE_VERSION);
  });
  it('vol_struct_v1 COMPOSITE_VERSION is the literal "vol_struct_v1"', () => {
    // Pin against typos. A future `vol_struct_v2` MUST be a deliberate
    // new SPEC, not a string-edit drift.
    assert.equal(COMPOSITE_VERSION, 'vol_struct_v1');
    assert.match(COMPOSITE_VERSION, /^vol_struct_v\d+$/);
  });
});

// ── normalCdf — golden-vector parity per SPEC §S-PBV1-2 ────────────────────

describe('normalCdf — Φ via Abramowitz & Stegun 26.2.17 per SPEC §S-PBV1-2', () => {
  it('Φ(0) = 0.5 (median of standard normal)', () => {
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9,
      `Φ(0) = ${normalCdf(0)}, expected 0.5`);
  });
  it('Φ(1) ≈ 0.8413 (P(Z<1) for standard normal; canonical table value)', () => {
    const phi1 = normalCdf(1);
    assert.ok(Math.abs(phi1 - 0.8413447460685429) < 1e-6,
      `Φ(1) = ${phi1}, expected ≈ 0.8413 (table value)`);
  });
  it('Φ(-1) ≈ 0.1587 (= 1 - Φ(1) by symmetry)', () => {
    const phiNeg1 = normalCdf(-1);
    assert.ok(Math.abs(phiNeg1 - 0.15865525393145707) < 1e-6,
      `Φ(-1) = ${phiNeg1}, expected ≈ 0.1587`);
  });
  it('Φ(2) ≈ 0.9772 (table value)', () => {
    const phi2 = normalCdf(2);
    assert.ok(Math.abs(phi2 - 0.9772498680518208) < 1e-6,
      `Φ(2) = ${phi2}, expected ≈ 0.9772`);
  });
  it('Φ(-2) ≈ 0.0228 (table value)', () => {
    const phiNeg2 = normalCdf(-2);
    assert.ok(Math.abs(phiNeg2 - 0.022750131948179195) < 1e-6,
      `Φ(-2) = ${phiNeg2}, expected ≈ 0.0228`);
  });
  it('Φ symmetry: Φ(z) + Φ(-z) = 1 across [-3, +3]', () => {
    for (let z = -3; z <= 3; z += 0.5) {
      const sum = normalCdf(z) + normalCdf(-z);
      assert.ok(Math.abs(sum - 1) < 1e-6,
        `Φ(${z}) + Φ(${-z}) = ${sum}, expected 1`);
    }
  });
  it('Φ monotonicity: strict on integers in [-3, +3]', () => {
    for (let z = -3; z < 3; z += 1) {
      assert.ok(normalCdf(z) < normalCdf(z + 1),
        `monotonicity violated at z=${z}: Φ(${z})=${normalCdf(z)} ≥ Φ(${z + 1})=${normalCdf(z + 1)}`);
    }
  });
  it('Φ monotonicity: fine-grained sweep z in [-2, +2] step 0.1', () => {
    let prev = normalCdf(-2.05);
    for (let z = -2.0; z <= 2.0; z += 0.1) {
      const cur = normalCdf(z);
      assert.ok(cur > prev,
        `monotonicity broken at z=${z.toFixed(2)}: prev=${prev}, cur=${cur}`);
      prev = cur;
    }
  });
  it('Φ(+Infinity) → 1 (saturation)', () => {
    assert.equal(normalCdf(Infinity), 1);
  });
  it('Φ(-Infinity) → 0 (saturation)', () => {
    assert.equal(normalCdf(-Infinity), 0);
  });
  it('Φ at extreme z: Φ(5) very close to 1 (>0.999999)', () => {
    assert.ok(normalCdf(5) > 0.999999,
      `Φ(5) = ${normalCdf(5)} should be > 0.999999`);
  });
  it('Φ at extreme z: Φ(-5) very close to 0 (<1e-6)', () => {
    assert.ok(normalCdf(-5) < 1e-6,
      `Φ(-5) = ${normalCdf(-5)} should be < 1e-6`);
  });
  it('Φ output always in [0, 1] across a wide sweep', () => {
    for (let z = -4; z <= 4; z += 0.25) {
      const phi = normalCdf(z);
      assert.ok(phi >= 0 && phi <= 1,
        `Φ(${z}) = ${phi} escaped [0, 1]`);
    }
  });
});

// ── normalCdf golden-vector parity vs reference erf-based values ───────────

describe('normalCdf — reference table parity (5-digit precision)', () => {
  // Reference values from any standard normal table OR scipy.stats.norm.cdf.
  // Tests asserts |actual - expected| < 1e-6.
  const cases: ReadonlyArray<{ z: number; expected: number }> = [
    { z: -3.0, expected: 0.0013498980316301035 },
    { z: -2.5, expected: 0.006209665325776133 },
    { z: -1.5, expected: 0.06680720126885809 },
    { z: -0.5, expected: 0.3085375387259869 },
    { z:  0.5, expected: 0.6914624612740131 },
    { z:  1.5, expected: 0.9331927987311419 },
    { z:  2.5, expected: 0.9937903346742238 },
    { z:  3.0, expected: 0.9986501019683699 },
  ];
  for (const c of cases) {
    it(`Φ(${c.z}) ≈ ${c.expected.toFixed(6)}`, () => {
      const actual = normalCdf(c.z);
      assert.ok(Math.abs(actual - c.expected) < 1e-6,
        `Φ(${c.z}) = ${actual}, expected ${c.expected} (diff ${Math.abs(actual - c.expected)})`);
    });
  }
});

// ── loadScoreSeries shape contract (mock CH) ───────────────────────────────

describe('loadScoreSeries — shape contract per SPEC §S-PBV1-2', () => {
  /**
   * Mock ClickHouseClient with a single query() method returning fixed rows.
   * Type-erased via `as never` because we only need the .query() method;
   * the real client interface is large.
   */
  function mockCh(rows: Array<{ d: string; z: string | number | null }>): unknown {
    return {
      query: async () => ({
        json: async () => rows,
      }),
    };
  }

  it('returns dates in ASC order + same-length scores in [0, 1]', async () => {
    const rows = [
      { d: '2013-01-03', z: -1.0 },
      { d: '2013-01-04', z:  0.0 },
      { d: '2013-01-07', z:  1.5 },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = await loadScoreSeries(mockCh(rows) as any);
    assert.equal(series.dates.length, 3);
    assert.equal(series.scores.length, 3);
    assert.deepEqual(series.dates, ['2013-01-03', '2013-01-04', '2013-01-07']);
    // Scores are Φ(z): Φ(-1) ≈ 0.1587, Φ(0) = 0.5, Φ(1.5) ≈ 0.9332.
    assert.ok(Math.abs(series.scores[0] - normalCdf(-1.0)) < 1e-9);
    assert.ok(Math.abs(series.scores[1] - 0.5) < 1e-9);
    assert.ok(Math.abs(series.scores[2] - normalCdf(1.5)) < 1e-9);
    // All scores in [0, 1]:
    for (const s of series.scores) {
      assert.ok(s >= 0 && s <= 1, `score=${s} escaped [0, 1]`);
    }
  });

  it('skips null curve_steepness_z rows defensively', async () => {
    const rows = [
      { d: '2013-01-03', z: -1.0 },
      { d: '2013-01-04', z: null },     // skip
      { d: '2013-01-07', z:  0.5 },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = await loadScoreSeries(mockCh(rows) as any);
    assert.equal(series.dates.length, 2);
    assert.deepEqual(series.dates, ['2013-01-03', '2013-01-07']);
  });

  it('skips non-finite z values defensively', async () => {
    const rows = [
      { d: '2013-01-03', z: NaN },      // skip
      { d: '2013-01-04', z: 'not-a-number' as unknown as string },   // parses to NaN → skip
      { d: '2013-01-07', z: 0.5 },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = await loadScoreSeries(mockCh(rows) as any);
    assert.equal(series.dates.length, 1);
    assert.deepEqual(series.dates, ['2013-01-07']);
  });

  it('parses string-encoded z (CH JSONEachRow numerics arrive as strings)', async () => {
    const rows = [
      { d: '2013-01-03', z: '1.5' },
      { d: '2013-01-04', z: '-0.5' },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = await loadScoreSeries(mockCh(rows) as any);
    assert.equal(series.scores.length, 2);
    assert.ok(Math.abs(series.scores[0] - normalCdf(1.5)) < 1e-9);
    assert.ok(Math.abs(series.scores[1] - normalCdf(-0.5)) < 1e-9);
  });

  it('throws loudly when query returns zero rows', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assert.rejects(
      () => loadScoreSeries(mockCh([]) as any),
      /no vol_structure_snapshots rows/,
    );
  });

  it('throws loudly when all rows have non-finite z after parse', async () => {
    const rows = [
      { d: '2013-01-03', z: NaN },
      { d: '2013-01-04', z: 'garbage' as unknown as string },
    ];
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => loadScoreSeries(mockCh(rows) as any),
      /0 finite curve_steepness_z values/,
    );
  });
});

// ── CSCV / slice-config inheritance ────────────────────────────────────────

describe('CSCV slice configuration at SPEC §S-PBV1-5 IS-length', () => {
  it('T ~2517 IS days → effectiveS=16 per cscv.ts MIN_BARS_FOR_S16=1024', () => {
    // SPEC-predicted IS bar count is ~2520 (10y of trading days);
    // dry-run confirmed 2517.
    assert.equal(resolveEffectiveS(2517), 16);
    assert.equal(resolveEffectiveS(2520), 16);
  });
  it('T = 1024 boundary returns 16 (DEFAULT_CSCV_S)', () => {
    assert.equal(resolveEffectiveS(1024), 16);
  });
  it('T = 1023 returns 8 (downshift)', () => {
    assert.equal(resolveEffectiveS(1023), 8);
  });
  it('T < 256 returns 0 (CSCV infeasible)', () => {
    assert.equal(resolveEffectiveS(255), 0);
  });
  it('computeSliceSharpes on synthetic 2517-bar series returns 16 finite values', () => {
    const T = 2517;
    const returns: number[] = new Array(T);
    for (let i = 0; i < T; i++) {
      returns[i] = ((i * 2654435761) % 1000) / 100000 - 0.005;
    }
    const slices = computeSliceSharpes(returns, 16);
    assert.equal(slices.length, 16);
    for (const s of slices) {
      assert.ok(Number.isFinite(s), `slice = ${s}; expected finite`);
    }
  });
});

// ── backtestTrial: walk-forward split divides cleanly at IS_END_DATE ───────

describe('Walk-forward split at IS_END_DATE = 2022-12-31', () => {
  // Build a tiny score + benchmark that straddles the split point.
  // We need at least one date on/before IS_END_DATE and one after.
  const score: ScoreSeries = {
    dates: ['2022-12-29', '2022-12-30', '2023-01-03', '2023-01-04'],
    scores: [0.6, 0.7, 0.4, 0.8],
  };
  const benchmark: BenchmarkSeries = {
    symbol: 'SPY',
    dates: ['2022-12-29', '2022-12-30', '2023-01-03', '2023-01-04'],
    returns: [0, 0.01, -0.005, 0.02],
  };

  it('bars on or before IS_END_DATE = 2022-12-31 land in IS', () => {
    const result = backtestTrial(score, benchmark, 0.5, IS_END_DATE);
    // IS = ['2022-12-29', '2022-12-30'] = 2 bars
    // OOS = ['2023-01-03', '2023-01-04'] = 2 bars
    assert.equal(result.isReturns.length, 2);
    assert.equal(result.oosReturns.length, 2);
  });

  it('OOS first bar date is the first trading day > 2022-12-31', () => {
    // The first OOS bar is '2023-01-03', consistent with SPEC OOS_START_DATE.
    const result = backtestTrial(score, benchmark, 0.5, IS_END_DATE);
    // Reconstruct: IS got 2 bars → benchmark.dates[2] = '2023-01-03' = OOS start.
    assert.equal(benchmark.dates[result.isReturns.length], OOS_START_DATE);
  });
});

// ── benchmarkTokenAddress re-export convention pin ─────────────────────────

describe('benchmarkTokenAddress re-export — convention pin', () => {
  it('SPY -> SPY_USD', () => {
    assert.equal(benchmarkTokenAddress('SPY'), 'SPY_USD');
  });
  it('QQQ -> QQQ_USD', () => {
    assert.equal(benchmarkTokenAddress('QQQ'), 'QQQ_USD');
  });
  it('IWM -> IWM_USD', () => {
    assert.equal(benchmarkTokenAddress('IWM'), 'IWM_USD');
  });
  it('vol_struct_v1 inherits the cycle_v1 _USD suffix convention', () => {
    assert.match(benchmarkTokenAddress('SPY'), /_USD$/);
  });
});

// ── ValidatorRequest / four-gate packaging convention ─────────────────────

describe('ValidatorRequest packaging — parametric Mertens DSR per S96-116', () => {
  it('runValidatorGatesForBenchmark NEVER passes perAssetSharpes (parametric path)', async () => {
    // The harness imports + calls runValidatorGatesForBenchmark from
    // phase_b_campaign_cycle_v1.ts. The cycle_v1 implementation calls
    // computeDsrGate WITHOUT perAssetSharpes per S96-116. Pinning here
    // ensures vol_struct_v1 inherits the same DSR-path discipline.
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/phase_b_campaign_cycle_v1.ts', 'utf-8'),
    );
    // Find the computeDsrGate call site via a brace-balancing scan
    // (regex can't handle nested {} robustly in the call args).
    const startIdx = src.indexOf('computeDsrGate(');
    assert.ok(startIdx >= 0, 'computeDsrGate call site not found in cycle_v1 harness');
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx + 'computeDsrGate'.length; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) { endIdx = i + 1; break; }
      }
    }
    assert.ok(endIdx > startIdx, 'computeDsrGate call site malformed (no closing paren)');
    const callSite = src.slice(startIdx, endIdx);
    // The call MUST NOT include perAssetSharpes (parametric Mertens path).
    assert.ok(!callSite.includes('perAssetSharpes'),
      `computeDsrGate call site includes perAssetSharpes (bootstrap path), ` +
      `violating S96-116:\n${callSite}`);
  });

  it('HLZ trial total = 19 × |BENCHMARKS| = 57 per SPEC §S-PBV1-7', () => {
    assert.equal(HLZ_TOTAL_TRIALS, THETA_GRID.length * BENCHMARKS.length);
    assert.equal(HLZ_TOTAL_TRIALS, 57);
  });

  it('validator.ts defaults match SignalForge gate thresholds (sanity check)', async () => {
    const validator = await import('../../src/lib/validator.js');
    assert.equal(validator.DEFAULT_DSR_GATE, 0.95);
    assert.equal(validator.DEFAULT_PBO_GATE, 0.50);
    assert.equal(validator.DEFAULT_PARDO_GATE, 0.50);
    assert.equal(validator.DEFAULT_HLZ_ALPHA, 0.05);
    assert.equal(validator.DEFAULT_HLZ_METHOD, 'bhy');
  });
});

// ── composite_version pin convention test on persisted rows ────────────────

describe('Persisted-row composite_version pin per SPEC §S-PBV1-9', () => {
  // The harness's runCampaign overrides compositeVersion on every trial
  // row + verdict row to 'vol_struct_v1' (the trialToRow + gateOutcomesTo
  // VerdictRow helpers bake 'cycle_v1' in via their import of cycle_v1's
  // COMPOSITE_VERSION). This test pins that override discipline so a
  // future refactor doesn't silently regress to writing 'cycle_v1' rows.
  it('trialToRow alone bakes cycle_v1 (documenting the override need)', () => {
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
    const row = trialToRow('SPY', 0.5, 9, probeResult,
      '2013-01-03', '2022-12-31', '2023-01-03', '2026-05-22');
    // Direct call bakes 'cycle_v1' — the harness's runCampaign performs
    // an explicit `row.compositeVersion = COMPOSITE_VERSION` override
    // to swap this to 'vol_struct_v1' before persistence.
    assert.equal(row.compositeVersion, 'cycle_v1',
      `trialToRow bakes cycle_v1; harness must override to ${COMPOSITE_VERSION}`);
  });

  it('harness compositeVersion swap restores vol_struct_v1', () => {
    // Simulate the swap the harness performs.
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
    const row = trialToRow('SPY', 0.5, 9, probeResult,
      '2013-01-03', '2022-12-31', '2023-01-03', '2026-05-22');
    row.compositeVersion = COMPOSITE_VERSION;
    assert.equal(row.compositeVersion, 'vol_struct_v1');
  });

  it('harness source contains explicit compositeVersion swap for trial rows', async () => {
    // Structural pin: ensure the harness file contains the override line
    // for trial rows. A refactor that removes the swap would surface here.
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/phase_b_campaign_vol_struct_v1.ts', 'utf-8'),
    );
    assert.match(src, /row\.compositeVersion\s*=\s*COMPOSITE_VERSION/,
      'harness missing the trial-row compositeVersion override');
  });

  it('harness source contains explicit compositeVersion swap for verdict rows', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/phase_b_campaign_vol_struct_v1.ts', 'utf-8'),
    );
    assert.match(src, /verdictRow\.compositeVersion\s*=\s*COMPOSITE_VERSION/,
      'harness missing the verdict-row compositeVersion override');
  });
});

// ── Live-CH convention check pointer (mirrors cycle_v1 Cycle 23 Fix 6) ────

describe('Live-CH convention pin pointer per SPEC §S-PBV1-9 + §8', () => {
  it('Step 0 pre-flight probe is the live-CH convention check', () => {
    // Documentation-only test mirroring Cycle 23 critic Fix 6: the live
    // CH state (snapshots table populated; composite_version=
    // 'vol_struct_v1' on every row; SPY/QQQ/IWM/VIX-family candles
    // present) is checked by the Step 0 probe at
    // `scripts/_probe_phase_b_vol_struct_v1_inputs.ts`, run before
    // every campaign invocation. Exit-non-zero on missing prereq is the
    // live convention pin; this unit test pins the FORMULA / config.
    assert.equal(COMPOSITE_VERSION, 'vol_struct_v1');
  });
});
