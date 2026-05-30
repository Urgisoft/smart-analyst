/**
 * Tests for scripts/phase_b_campaign_short_interest_v1.ts — the Cycle 41
 * Composite worker's deflation-pipeline harness for short_interest_v1.
 *
 * Coverage (≥40 tests, mirrors phaseBCampaignCrossAssetV1.test.ts §5):
 *   - SPEC-pinned constants (COMPOSITE_VERSION, BENCHMARKS, THETA_GRID, window
 *     dates, MAX_SCORE_GAP_DAYS biweekly-cadence value, HLZ M, PBO gate).
 *   - normalCdf golden-vector parity (Φ(0)=0.5, Φ(±1), Φ(±2), reference table).
 *   - normalCdf monotonicity + domain edge cases + fork-copy parity with the
 *     predecessor harnesses (cross_asset_v1 / vol_struct_v1).
 *   - **POLARITY-ALIGNED source-text pin** (§S-PBSI1-2 critical pin): high
 *     aggregate-short-z → HIGH score (contrarian-bullish per APR 2005 §4);
 *     loadScoreSeries applies NO negation (DIRECT relationship). A worker who
 *     copy-pasted sector_rot_v1's negate-before-Φ would invert the read.
 *   - loadScoreSeries shape: ascending dates + same-length scores in [0,1].
 *   - **computeBetaCheck pure-function tests** — the load-bearing beta-vs-alpha
 *     diagnostic (the aggregate-market-timing honesty check).
 *   - composite_version anti-shopping pin (differs from all predecessors).
 *
 * The harness's runCampaign / persistCampaign / CLI are I/O-bound (require
 * live CH); tests focus on the pure-function deltas + constants + the
 * beta-check, mirroring the predecessor test posture.
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
  computeBetaCheck,
  benchmarkTokenAddress,
} from '../phase_b_campaign_short_interest_v1.js';
import {
  type ScoreSeries,
  type BenchmarkSeries,
} from '../phase_b_campaign_cycle_v1.js';
import { COMPOSITE_VERSION as CYCLE_V1_COMPOSITE_VERSION } from '../phase_b_campaign_cycle_v1.js';
import { COMPOSITE_VERSION as CROSS_ASSET_V1_COMPOSITE_VERSION } from '../phase_b_campaign_cross_asset_v1.js';
import { COMPOSITE_VERSION as VOL_STRUCT_V1_COMPOSITE_VERSION } from '../phase_b_campaign_vol_struct_v1.js';
import { COMPOSITE_VERSION as SECTOR_ROT_V1_COMPOSITE_VERSION } from '../phase_b_campaign_sector_rot_v1.js';
import { normalCdf as crossAssetNormalCdf } from '../phase_b_campaign_cross_asset_v1.js';
import { normalCdf as volStructNormalCdf } from '../phase_b_campaign_vol_struct_v1.js';

// ── SPEC-pinned constants — anti-result-shopping audit ─────────────────────

describe('SPEC-pinned constants — ADR-051 + short_interest_v1 §S-PBSI1', () => {
  it('COMPOSITE_VERSION = "short_interest_v1" (anti-result-shopping audit key)', () => {
    assert.equal(COMPOSITE_VERSION, 'short_interest_v1');
  });
  it('BENCHMARKS = [SPY, QQQ, IWM] per ADR-051 D2', () => {
    assert.deepEqual([...BENCHMARKS], ['SPY', 'QQQ', 'IWM']);
  });
  it('THETA_GRID has 19 trials at step 0.05 per ADR-051 D1', () => {
    assert.equal(THETA_GRID.length, 19);
    assert.equal(THETA_GRID[0], 0.05);
    assert.equal(THETA_GRID[18], 0.95);
    for (let i = 1; i < THETA_GRID.length; i++) {
      const diff = THETA_GRID[i] - THETA_GRID[i - 1];
      assert.ok(Math.abs(diff - 0.05) < 1e-9, `θ step ≠ 0.05 at ${i}`);
    }
  });
  it('WINDOW_START_DATE = "2020-01-15" (FINRA short-interest coverage start)', () => {
    assert.equal(WINDOW_START_DATE, '2020-01-15');
  });
  it('IS_END_DATE = "2024-06-30" (degraded-window split, pinned a priori)', () => {
    assert.equal(IS_END_DATE, '2024-06-30');
  });
  it('OOS_START_DATE = "2024-07-01"', () => {
    assert.equal(OOS_START_DATE, '2024-07-01');
  });
  it('MAX_SCORE_GAP_DAYS = 12 (biweekly-cadence match, NOT a tuning knob)', () => {
    // The aggregate z is a step function flat between biweekly FINRA
    // publications (~10 trading days apart). The gap floor is raised to 12
    // to accommodate the biweekly forward-fill — a source-cadence match, not
    // a fitted parameter. cycle_v1's 4 is for daily snapshots.
    assert.equal(MAX_SCORE_GAP_DAYS, 12);
  });
  it('DEFAULT_CSCV_S = 16 (auto-downshift to 8 if T<1024)', () => {
    assert.equal(DEFAULT_CSCV_S, 16);
  });
  it('HLZ_TOTAL_TRIALS = 57 (19 × 3) per ADR-051 D2', () => {
    assert.equal(HLZ_TOTAL_TRIALS, 57);
  });
  it('PHASE_C_PBO_GATE = 0.2 per ADR-051 §Decision 5', () => {
    assert.equal(PHASE_C_PBO_GATE, 0.2);
  });
  it('IS window is ≥ 3y (degraded but CSCV-resolvable: ≥256 IS bars ⇒ S≥4)', () => {
    const start = new Date(WINDOW_START_DATE + 'T00:00:00Z').getTime();
    const end = new Date(IS_END_DATE + 'T00:00:00Z').getTime();
    const years = (end - start) / (1000 * 60 * 60 * 24 * 365.25);
    // The z-baseline warmup eats ~15 months, so the EFFECTIVE IS span is
    // ~2021-04 → 2024-06 (~3.2y). The nominal start→IS-end span is wider; we
    // assert it is comfortably above the CSCV minimum.
    assert.ok(years >= 4.0, `start→IS-end span only ${years.toFixed(2)}y`);
  });
});

// ── COMPOSITE_VERSION anti-shopping audit ──────────────────────────────────

describe('Composite-version pin — anti-shopping rule per ADR-051 §Decision 8', () => {
  it('differs from cycle_v1', () => {
    assert.notEqual(COMPOSITE_VERSION, CYCLE_V1_COMPOSITE_VERSION);
  });
  it('differs from cross_asset_v1', () => {
    assert.notEqual(COMPOSITE_VERSION, CROSS_ASSET_V1_COMPOSITE_VERSION);
  });
  it('differs from vol_struct_v1', () => {
    assert.notEqual(COMPOSITE_VERSION, VOL_STRUCT_V1_COMPOSITE_VERSION);
  });
  it('differs from sector_rot_v1', () => {
    assert.notEqual(COMPOSITE_VERSION, SECTOR_ROT_V1_COMPOSITE_VERSION);
  });
  it('is the literal "short_interest_v1" matching /^short_interest_v\\d+$/', () => {
    assert.equal(COMPOSITE_VERSION, 'short_interest_v1');
    assert.match(COMPOSITE_VERSION, /^short_interest_v\d+$/);
  });
});

// ── normalCdf — golden-vector parity ───────────────────────────────────────

describe('normalCdf — Φ via Abramowitz & Stegun 26.2.17', () => {
  it('Φ(0) = 0.5', () => {
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
  });
  it('Φ(1) ≈ 0.8413', () => {
    assert.ok(Math.abs(normalCdf(1) - 0.8413447460685429) < 1e-6);
  });
  it('Φ(-1) ≈ 0.1587', () => {
    assert.ok(Math.abs(normalCdf(-1) - 0.15865525393145707) < 1e-6);
  });
  it('Φ(2) ≈ 0.9772', () => {
    assert.ok(Math.abs(normalCdf(2) - 0.9772498680518208) < 1e-6);
  });
  it('Φ(-2) ≈ 0.0228', () => {
    assert.ok(Math.abs(normalCdf(-2) - 0.022750131948179195) < 1e-6);
  });
  it('Φ monotonic on integers [-3, +3]', () => {
    for (let z = -3; z < 3; z += 1) {
      assert.ok(normalCdf(z) < normalCdf(z + 1));
    }
  });
  it('Φ(+Infinity) → 1, Φ(-Infinity) → 0', () => {
    assert.equal(normalCdf(Infinity), 1);
    assert.equal(normalCdf(-Infinity), 0);
  });
  it('Φ(NaN) → 0 (defensive)', () => {
    assert.equal(normalCdf(NaN), 0);
  });
  it('Φ output always in [0,1] across a wide sweep', () => {
    for (let z = -4; z <= 4; z += 0.25) {
      const phi = normalCdf(z);
      assert.ok(phi >= 0 && phi <= 1, `Φ(${z})=${phi} escaped [0,1]`);
    }
  });
});

describe('normalCdf — reference table parity (1e-6)', () => {
  const cases: ReadonlyArray<{ z: number; expected: number }> = [
    { z: -3.0, expected: 0.0013498980316301035 },
    { z: -1.5, expected: 0.06680720126885809 },
    { z: -0.5, expected: 0.3085375387259869 },
    { z:  0.5, expected: 0.6914624612740131 },
    { z:  1.5, expected: 0.9331927987311419 },
    { z:  3.0, expected: 0.9986501019683699 },
  ];
  for (const c of cases) {
    it(`Φ(${c.z}) ≈ ${c.expected.toFixed(6)}`, () => {
      assert.ok(Math.abs(normalCdf(c.z) - c.expected) < 1e-6);
    });
  }
});

describe('normalCdf — fork-copy parity with predecessors per S96-118', () => {
  it('bit-identical to cross_asset_v1 across [-3, +3]', () => {
    for (let z = -3; z <= 3; z += 0.25) {
      assert.equal(normalCdf(z), crossAssetNormalCdf(z), `parity broken at z=${z}`);
    }
  });
  it('bit-identical to vol_struct_v1 across [-3, +3]', () => {
    for (let z = -3; z <= 3; z += 0.25) {
      assert.equal(normalCdf(z), volStructNormalCdf(z), `parity broken at z=${z}`);
    }
  });
});

// ── POLARITY-ALIGNED DIRECTIONAL BEHAVIOR — load-bearing harness pin ───────

describe('loadScoreSeries polarity-ALIGNED — §S-PBSI1-2 (Asquith-Pathak-Ritter contrarian)', () => {
  function mockCh(rows: Array<{ d: string; z: string | number | null }>): unknown {
    return { query: async () => ({ json: async () => rows }) };
  }

  it('HIGH aggregate-short-z maps to HIGH score (contrarian-bullish → long-favorable)', async () => {
    const rows = [{ d: '2022-01-03', z: 1.5 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = await loadScoreSeries(mockCh(rows) as any);
    assert.equal(series.scores.length, 1);
    assert.ok(series.scores[0] > 0.9, `high-z → high score; got ${series.scores[0]}`);
    assert.ok(Math.abs(series.scores[0] - normalCdf(1.5)) < 1e-9);
  });

  it('LOW aggregate-short-z maps to LOW score (low short → flat-favorable)', async () => {
    const rows = [{ d: '2022-01-03', z: -1.5 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = await loadScoreSeries(mockCh(rows) as any);
    assert.ok(series.scores[0] < 0.1, `low-z → low score; got ${series.scores[0]}`);
    assert.ok(Math.abs(series.scores[0] - normalCdf(-1.5)) < 1e-9);
  });

  it('z = 0 maps to score = 0.5 (median)', async () => {
    const rows = [{ d: '2022-01-03', z: 0.0 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = await loadScoreSeries(mockCh(rows) as any);
    assert.ok(Math.abs(series.scores[0] - 0.5) < 1e-9);
  });

  it('score matches Φ(z) NOT Φ(-z) across a grid (catches sector_rot_v1 negation copy-paste)', async () => {
    const zs = [-2.0, -1.0, -0.5, 0.0, 0.5, 1.0, 2.0];
    const rows = zs.map((z, i) => ({ d: `2022-01-${String(i + 3).padStart(2, '0')}`, z }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = await loadScoreSeries(mockCh(rows) as any);
    for (let i = 0; i < zs.length; i++) {
      assert.ok(Math.abs(series.scores[i] - normalCdf(zs[i])) < 1e-9,
        `z=${zs[i]} → expected Φ(z)=${normalCdf(zs[i])}, got ${series.scores[i]}`);
      if (zs[i] !== 0) {
        assert.ok(Math.abs(series.scores[i] - normalCdf(-zs[i])) > 1e-3,
          `score at z=${zs[i]} matches Φ(-z) — worker copy-pasted sector_rot_v1 negation; ` +
          `short_interest is polarity-ALIGNED (APR 2005 contrarian)`);
      }
    }
  });

  it('score is monotonically INCREASING in z (NOT decreasing)', async () => {
    const zs = [-2, -1, 0, 1, 2];
    const rows = zs.map((z, i) => ({ d: `2022-01-${String(i + 3).padStart(2, '0')}`, z }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = await loadScoreSeries(mockCh(rows) as any);
    for (let i = 1; i < series.scores.length; i++) {
      assert.ok(series.scores[i] > series.scores[i - 1],
        `score not increasing with z at idx ${i}`);
    }
  });

  it('loadScoreSeries shape: ascending dates, same-length scores, scores in [0,1]', async () => {
    const rows = [
      { d: '2022-01-03', z: -1.0 },
      { d: '2022-01-04', z: 0.5 },
      { d: '2022-01-05', z: 2.0 },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = await loadScoreSeries(mockCh(rows) as any);
    assert.equal(series.dates.length, series.scores.length);
    for (let i = 1; i < series.dates.length; i++) {
      assert.ok(series.dates[i] > series.dates[i - 1], 'dates not ascending');
    }
    for (const s of series.scores) assert.ok(s >= 0 && s <= 1);
  });

  it('null + non-finite z rows are skipped (belt-and-suspenders defensive filter)', async () => {
    const rows: Array<{ d: string; z: string | number | null }> = [
      { d: '2022-01-03', z: null },
      { d: '2022-01-04', z: 'not-a-number' },
      { d: '2022-01-05', z: 1.0 },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = await loadScoreSeries(mockCh(rows) as any);
    assert.equal(series.scores.length, 1);
    assert.equal(series.dates[0], '2022-01-05');
  });

  it('throws loud when zero usable rows (ADR-044 data-integrity)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assert.rejects(() => loadScoreSeries(mockCh([]) as any), /no short_interest_snapshots rows/);
  });
});

// ── computeBetaCheck — the load-bearing beta-vs-alpha diagnostic ────────────

describe('computeBetaCheck — aggregate-market-timing beta honesty check', () => {
  // A tiny synthetic score + benchmark. Score is high (always > θ) so the
  // strategy is fully long → it must equal buy-and-hold (beta, not alpha).
  function makeSeries(): { score: ScoreSeries; bench: BenchmarkSeries } {
    const dates = [
      '2021-04-15', '2021-04-16', '2021-04-19', '2021-04-20', // IS
      '2024-07-01', '2024-07-02', '2024-07-03', '2024-07-05', // OOS
    ];
    // Score always 0.99 → above any θ ≤ 0.95 → always long.
    const score: ScoreSeries = { dates, scores: dates.map(() => 0.99) };
    const bench: BenchmarkSeries = {
      symbol: 'SPY',
      dates,
      returns: [0, 0.01, -0.005, 0.008, 0, 0.012, -0.003, 0.006],
    };
    return { score, bench };
  }

  it('a fully-long strategy equals buy-and-hold OOS (beta, NOT alpha)', () => {
    const { score, bench } = makeSeries();
    const bc = computeBetaCheck(score, bench, 0.5, '2024-06-30');
    // Always-long ⇒ strat OOS SR == buy-hold OOS SR (within FP tolerance).
    assert.ok(Math.abs(bc.stratOosSharpe - bc.buyHoldOosSharpe) < 1e-9,
      `fully-long strat should equal buy-and-hold OOS; ` +
      `strat=${bc.stratOosSharpe} bh=${bc.buyHoldOosSharpe}`);
    assert.equal(bc.beatsBuyHoldOos, false, 'equal-to-B&H is NOT beating it (beta)');
  });

  it('fully-long strategy reports ~100% OOS days-in-market', () => {
    const { score, bench } = makeSeries();
    const bc = computeBetaCheck(score, bench, 0.5, '2024-06-30');
    assert.ok(bc.oosDaysInMarketFrac > 0.99,
      `fully-long → ~100% days-in-market; got ${bc.oosDaysInMarketFrac}`);
  });

  it('a selective strategy (score below θ on a down day) can beat buy-and-hold', () => {
    // Score is low (0.1) on the OOS down-days, high (0.99) on up-days, so the
    // strategy sidesteps the loss → can BEAT buy-and-hold (alpha shape).
    const dates = [
      '2021-04-15', '2021-04-16', '2021-04-19', '2021-04-20',
      '2024-07-01', '2024-07-02', '2024-07-03', '2024-07-05',
    ];
    // position(t) uses score(t-1) > θ. Returns: down day at index 6 (-0.05).
    // Set score(t-1=5)=0.1 so the strategy is FLAT on the index-6 down day.
    const scores = [0.99, 0.99, 0.99, 0.99, 0.99, 0.1, 0.99, 0.99];
    const score: ScoreSeries = { dates, scores };
    const bench: BenchmarkSeries = {
      symbol: 'SPY', dates,
      returns: [0, 0.01, 0.01, 0.01, 0.01, 0.01, -0.05, 0.01],
    };
    const bc = computeBetaCheck(score, bench, 0.5, '2024-06-30');
    // The strategy avoids the -0.05 OOS day; its Sharpe should differ from
    // (and here exceed) buy-and-hold.
    assert.ok(bc.stratOosSharpe !== bc.buyHoldOosSharpe,
      'selective strategy should differ from buy-and-hold');
    assert.ok(bc.oosDaysInMarketFrac < 1.0,
      `selective strategy is not fully long; got ${bc.oosDaysInMarketFrac}`);
  });

  it('beatsBuyHoldOos is true iff stratOosSharpe > buyHoldOosSharpe', () => {
    const { score, bench } = makeSeries();
    const bc = computeBetaCheck(score, bench, 0.5, '2024-06-30');
    assert.equal(bc.beatsBuyHoldOos, bc.stratOosSharpe > bc.buyHoldOosSharpe);
  });
});

// ── benchmarkTokenAddress re-export convention pin ─────────────────────────

describe('benchmarkTokenAddress re-export', () => {
  it('SPY → SPY_USD (yfinance convention)', () => {
    assert.equal(benchmarkTokenAddress('SPY'), 'SPY_USD');
  });
});
