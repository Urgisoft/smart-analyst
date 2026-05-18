/**
 * Unit tests for ADR-040 cell-weight math + orchestration.
 *
 * SPEC: docs/specs/correlation-weighted-per-cell-allocation.md §12.
 *
 * Test numbering matches §12 exactly:
 *   T0-1..T0-4  — equal-weight forced
 *   T1-1..T1-7  — IVW forced
 *   T2-1..T2-6  — HRP forced (5 against Python-reference fixtures)
 *   TRIG-1..TRIG-12 + 28a TRIG-DATA + 28b RATCHET-N-CHANGE — selectCellWeightsTier
 *   TIER-PARITY (L-2, session 72) — 720-row Python↔TS sweep + sufficiency flags
 *   AUTO-1..AUTO-3 — auto-tier dispatch
 *   EDGE-1..EDGE-5 + 36a EDGE-6 — caller-bug throws + cold-start
 *   DATA-1..DATA-4 — getCellDailyReturns with injected executor
 *   LOG-1..LOG-4 — formatCellWeightsLogLine byte-pin
 *   ORCH-1..ORCH-3 — resolveCellWeightsForRun
 *   50c DEGRADED-RATCHET — H-2 critic byte-pin
 *
 * INT-1/2/3 + 50a/50b live in perCellCapital.test.ts (composition tests).
 * Brief-render tests 51-55 live in operatorBriefRender.test.ts.
 * Migration smoke test 56 — pure DDL constant check at bottom of this file.
 *
 * Run via `node --import tsx --test scripts/tests/cellWeights.test.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeCellWeights,
  formatCellWeightsLogLine,
  ROLLING_WINDOW_DAYS_T2,
  selectCellWeightsTier,
  TIER_TRIGGERS,
  type CellWeightsTier,
} from '../../src/server/cell_weights.js';
import { getCellDailyReturns } from '../../src/server/cell_pnl_history.js';
import {
  resolveCellWeightsForRun,
  type ResolveCellWeightsResult,
} from '../../src/server/per_cell_capital.js';
import { DDL_CELL_WEIGHTS_HISTORY } from '../migrate_cell_weights_history.js';

const TOL = 1e-9;
const APPROX_TOL = 1e-4;

// Build a zero-filled series of length 180 with a single non-zero value
// somewhere — used to exercise T0/EDGE paths where the math layer just
// needs *something* of the right length.
function zerosWithSpike(idx: number, val: number, length = ROLLING_WINDOW_DAYS_T2): number[] {
  const s = new Array<number>(length).fill(0);
  s[idx] = val;
  return s;
}

// Deterministic Gaussian (Box-Muller) — for T1 variance tests we need a
// series with a KNOWN variance. We instead build series whose sample
// variance is a closed-form expression — see specific tests.

// ---------------------------------------------------------------------------
// T0 forced (#T0-1..T0-4)
// ---------------------------------------------------------------------------
describe('computeCellWeights — T0 forced (equal-weight)', () => {
  it('#T0-1 tier=T0, N=1 → {a:1.0}', () => {
    const r = computeCellWeights({
      cellKeys: ['a'],
      dailyReturns: new Map([['a', [0]]]),
      closedTradeCounts: new Map([['a', 0]]),
      observedDays: new Map([['a', 0]]),
      tier: 'T0',
      priorActiveTier: null,
    });
    assert.equal(r.tierActive, 'T0');
    assert.equal(r.weights.get('a'), 1);
  });

  it('#T0-2 tier=T0, N=2 → {a:0.5, b:0.5}', () => {
    const r = computeCellWeights({
      cellKeys: ['a', 'b'],
      dailyReturns: new Map([['a', [0]], ['b', [0]]]),
      closedTradeCounts: new Map([['a', 0], ['b', 0]]),
      observedDays: new Map([['a', 0], ['b', 0]]),
      tier: 'T0',
      priorActiveTier: null,
    });
    assert.equal(r.tierActive, 'T0');
    assert.equal(r.weights.get('a'), 0.5);
    assert.equal(r.weights.get('b'), 0.5);
  });

  it('#T0-3 tier=T0, N=4 → equal split', () => {
    const r = computeCellWeights({
      cellKeys: ['a', 'b', 'c', 'd'],
      dailyReturns: new Map([['a', [0]], ['b', [0]], ['c', [0]], ['d', [0]]]),
      closedTradeCounts: new Map([['a', 0], ['b', 0], ['c', 0], ['d', 0]]),
      observedDays: new Map([['a', 0], ['b', 0], ['c', 0], ['d', 0]]),
      tier: 'T0',
      priorActiveTier: null,
    });
    for (const k of ['a', 'b', 'c', 'd']) assert.equal(r.weights.get(k), 0.25);
  });

  it('#T0-4 tier=T0, N=3 → sum invariant', () => {
    const r = computeCellWeights({
      cellKeys: ['a', 'b', 'c'],
      dailyReturns: new Map([['a', [0]], ['b', [0]], ['c', [0]]]),
      closedTradeCounts: new Map([['a', 0], ['b', 0], ['c', 0]]),
      observedDays: new Map([['a', 0], ['b', 0], ['c', 0]]),
      tier: 'T0',
      priorActiveTier: null,
    });
    const sum = r.weights.get('a')! + r.weights.get('b')! + r.weights.get('c')!;
    assert.ok(Math.abs(sum - 1) < TOL, `sum=${sum}`);
  });
});

// ---------------------------------------------------------------------------
// T1 forced (#T1-1..T1-7)
// Build series with KNOWN sample variance via `[+s, -s, +s, -s, ...]` patterns
// (T elements → ddof=1 variance = s² × T/(T-1)).
// ---------------------------------------------------------------------------
function seriesWithVariance(variance: number, t = 100): number[] {
  // Mean-zero series of length t with sample variance EXACTLY = variance.
  // Use [+s, -s] repeating; sample var = (t/(t-1)) × s². Solve for s.
  const s = Math.sqrt(variance * (t - 1) / t);
  return Array.from({ length: t }, (_, i) => (i % 2 === 0 ? s : -s));
}

describe('computeCellWeights — T1 forced (IVW)', () => {
  it('#T1-1 equal variance = equal weight', () => {
    const r = computeCellWeights({
      cellKeys: ['a', 'b'],
      dailyReturns: new Map([
        ['a', seriesWithVariance(1.0)],
        ['b', seriesWithVariance(1.0)],
      ]),
      closedTradeCounts: new Map([['a', 100], ['b', 100]]),
      observedDays: new Map([['a', 90], ['b', 90]]),
      tier: 'T1',
      priorActiveTier: null,
    });
    assert.equal(r.tierActive, 'T1');
    assert.ok(Math.abs(r.weights.get('a')! - 0.5) < TOL);
    assert.ok(Math.abs(r.weights.get('b')! - 0.5) < TOL);
  });

  it('#T1-2 σ²={1,2} → w_a = 2/3 (IVW closed form)', () => {
    const r = computeCellWeights({
      cellKeys: ['a', 'b'],
      dailyReturns: new Map([
        ['a', seriesWithVariance(1.0)],
        ['b', seriesWithVariance(2.0)],
      ]),
      closedTradeCounts: new Map([['a', 100], ['b', 100]]),
      observedDays: new Map([['a', 90], ['b', 90]]),
      tier: 'T1',
      priorActiveTier: null,
    });
    assert.ok(Math.abs(r.weights.get('a')! - 2 / 3) < APPROX_TOL);
    assert.ok(Math.abs(r.weights.get('b')! - 1 / 3) < APPROX_TOL);
  });

  it('#T1-3 σ²={4,1} → w_a=0.20, w_b=0.80', () => {
    const r = computeCellWeights({
      cellKeys: ['a', 'b'],
      dailyReturns: new Map([
        ['a', seriesWithVariance(4.0)],
        ['b', seriesWithVariance(1.0)],
      ]),
      closedTradeCounts: new Map([['a', 100], ['b', 100]]),
      observedDays: new Map([['a', 90], ['b', 90]]),
      tier: 'T1',
      priorActiveTier: null,
    });
    assert.ok(Math.abs(r.weights.get('a')! - 0.2) < APPROX_TOL);
    assert.ok(Math.abs(r.weights.get('b')! - 0.8) < APPROX_TOL);
  });

  it('#T1-4 N=4 σ²={1,1,1,4} → IVW formula', () => {
    const r = computeCellWeights({
      cellKeys: ['a', 'b', 'c', 'd'],
      dailyReturns: new Map([
        ['a', seriesWithVariance(1.0)],
        ['b', seriesWithVariance(1.0)],
        ['c', seriesWithVariance(1.0)],
        ['d', seriesWithVariance(4.0)],
      ]),
      closedTradeCounts: new Map([['a', 100], ['b', 100], ['c', 100], ['d', 100]]),
      observedDays: new Map([['a', 90], ['b', 90], ['c', 90], ['d', 90]]),
      tier: 'T1',
      priorActiveTier: null,
    });
    // w_i ∝ 1/σ²; sum_inv = 1+1+1+0.25 = 3.25 → w_a=w_b=w_c=1/3.25, w_d=0.25/3.25.
    assert.ok(Math.abs(r.weights.get('a')! - 1 / 3.25) < APPROX_TOL);
    assert.ok(Math.abs(r.weights.get('d')! - 0.25 / 3.25) < APPROX_TOL);
  });

  it('#T1-5 Bessel-corrected variance: [1,2,3,4,5] → σ²=2.5 (NOT 2.0)', () => {
    // For [1,2,3,4,5]: mean=3, sse = 4+1+0+1+4 = 10, ddof=1 var = 10/4 = 2.5.
    // Pair with a zero-mean length-5 series of known var=10. Pattern
    // [s, -s, s, -s, 0] is zero-mean; sse = 4s²; var = sse/(n-1) = s²
    // → for var=10, s=√10.
    const a = [1, 2, 3, 4, 5];
    const s = Math.sqrt(10);
    const b = [s, -s, s, -s, 0];   // mean=0, sample var = 4×10/4 = 10
    const r = computeCellWeights({
      cellKeys: ['a', 'b'],
      dailyReturns: new Map([['a', a], ['b', b]]),
      closedTradeCounts: new Map([['a', 100], ['b', 100]]),
      observedDays: new Map([['a', 90], ['b', 90]]),
      tier: 'T1',
      priorActiveTier: null,
    });
    // w_a = (1/2.5) / (1/2.5 + 1/10) = 0.4 / 0.5 = 0.8
    assert.ok(Math.abs(r.weights.get('a')! - 0.8) < APPROX_TOL);
    assert.ok(Math.abs(r.weights.get('b')! - 0.2) < APPROX_TOL);
  });

  it('#T1-6 N=1 + tier=T1 → throws', () => {
    assert.throws(
      () => computeCellWeights({
        cellKeys: ['a'],
        dailyReturns: new Map([['a', [0.1, -0.1]]]),
        closedTradeCounts: new Map([['a', 100]]),
        observedDays: new Map([['a', 90]]),
        tier: 'T1',
        priorActiveTier: null,
      }),
      /T1 requires N >= 2/i,
    );
  });

  it('#T1-7 σ²<1e-12 (all-zeros) → throws', () => {
    assert.throws(
      () => computeCellWeights({
        cellKeys: ['a', 'b'],
        dailyReturns: new Map([
          ['a', new Array(100).fill(0)],
          ['b', new Array(100).fill(0)],
        ]),
        closedTradeCounts: new Map([['a', 100], ['b', 100]]),
        observedDays: new Map([['a', 90], ['b', 90]]),
        tier: 'T1',
        priorActiveTier: null,
      }),
      /variance floor breach/i,
    );
  });
});

// ---------------------------------------------------------------------------
// T2 forced — fixture-driven (#T2-1..T2-6)
// ---------------------------------------------------------------------------

interface CellWeightsFixture {
  id: string;
  input: {
    cellKeys: string[];
    dailyReturns: Record<string, number[]>;
    closedTradeCounts: Record<string, number>;
    observedDays: Record<string, number>;
    tier: 'auto' | CellWeightsTier;
    priorActiveTier: CellWeightsTier | null;
  };
  expected: { tierActive: CellWeightsTier; weights: Record<string, number> };
}

function loadFixture(id: string): CellWeightsFixture {
  const path = join(process.cwd(), `scripts/tests/fixtures/cell_weights/${id}.json`);
  return JSON.parse(readFileSync(path, 'utf-8')) as CellWeightsFixture;
}

function runFixture(f: CellWeightsFixture): ReturnType<typeof computeCellWeights> {
  return computeCellWeights({
    cellKeys: f.input.cellKeys,
    dailyReturns: new Map(Object.entries(f.input.dailyReturns)),
    closedTradeCounts: new Map(Object.entries(f.input.closedTradeCounts)),
    observedDays: new Map(Object.entries(f.input.observedDays)),
    tier: f.input.tier,
    priorActiveTier: f.input.priorActiveTier,
  });
}

describe('computeCellWeights — T2 forced (HRP, byte-pinned against Python ref)', () => {
  it('#T2-1 fixture: N=4 two correlated pairs', () => {
    const f = loadFixture('hrp_n4_two_correlated_pairs');
    const r = runFixture(f);
    assert.equal(r.tierActive, 'T2');
    for (const k of f.input.cellKeys) {
      assert.ok(
        Math.abs(r.weights.get(k)! - f.expected.weights[k]) < TOL,
        `weight[${k}] got=${r.weights.get(k)} want=${f.expected.weights[k]}`,
      );
    }
  });

  it('#T2-2 fixture: N=4 all-uncorrelated', () => {
    const f = loadFixture('hrp_n4_uncorrelated');
    const r = runFixture(f);
    assert.equal(r.tierActive, 'T2');
    for (const k of f.input.cellKeys) {
      assert.ok(
        Math.abs(r.weights.get(k)! - f.expected.weights[k]) < TOL,
      );
    }
  });

  it('#T2-3 fixture: N=4 NON-alphabetical input — Map iteration order preserved', () => {
    const f = loadFixture('hrp_n4_non_alphabetical_input');
    const r = runFixture(f);
    assert.equal(r.tierActive, 'T2');
    // Per SPEC §5/§6.3.1 — Map iteration order matches `inputs.cellKeys` order
    // (NOT alphabetical). This is the discriminator for the canonicalization
    // path: a buggy implementation returning weights keyed alphabetically
    // would fail here.
    const keysInOrder = Array.from(r.weights.keys());
    assert.deepEqual(keysInOrder, f.input.cellKeys);
    for (const k of f.input.cellKeys) {
      assert.ok(
        Math.abs(r.weights.get(k)! - f.expected.weights[k]) < TOL,
      );
    }
  });

  it('#T2-4 N=1 + tier=T2 → throws', () => {
    assert.throws(
      () => computeCellWeights({
        cellKeys: ['a'],
        dailyReturns: new Map([['a', new Array(180).fill(0.001)]]),
        closedTradeCounts: new Map([['a', 100]]),
        observedDays: new Map([['a', 180]]),
        tier: 'T2',
        priorActiveTier: null,
      }),
      /T2 requires N >= 2/i,
    );
  });

  it('#T2-5 N=2 fixture: HRP collapses to IVW at N=2', () => {
    const f = loadFixture('hrp_n2_collapses_to_ivw');
    const r = runFixture(f);
    assert.equal(r.tierActive, 'T2');
    for (const k of f.input.cellKeys) {
      assert.ok(
        Math.abs(r.weights.get(k)! - f.expected.weights[k]) < TOL,
      );
    }
  });

  it('#T2-6 weight-sum invariant across all T2 fixtures', () => {
    const dir = join(process.cwd(), 'scripts/tests/fixtures/cell_weights');
    // Only HRP-shape fixtures (id prefix `hrp_*`); skip parity / non-weight
    // fixtures like `tier_selection_parity.json` (session 72) that share the
    // directory but have a different shape.
    const hrpFiles = readdirSync(dir).filter(f => f.startsWith('hrp_') && f.endsWith('.json'));
    assert.ok(hrpFiles.length > 0, 'expected at least one hrp_* fixture');
    for (const file of hrpFiles) {
      const f = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as CellWeightsFixture;
      const r = runFixture(f);
      let sum = 0;
      for (const v of r.weights.values()) sum += v;
      assert.ok(Math.abs(sum - 1) < TOL, `${file}: sum=${sum}`);
    }
  });
});

// ---------------------------------------------------------------------------
// selectCellWeightsTier (#TRIG-1..TRIG-12 + 28a TRIG-DATA + 28b RATCHET-N-CHANGE)
// ---------------------------------------------------------------------------
describe('selectCellWeightsTier — trigger conditions', () => {
  it('#TRIG-1 N=2 obsDays=89 trades=30 prior=null → T0', () => {
    assert.equal(selectCellWeightsTier(2, 89, 30, null), 'T0');
  });
  it('#TRIG-2 N=2 obsDays=90 trades=29 prior=null → T0', () => {
    assert.equal(selectCellWeightsTier(2, 90, 29, null), 'T0');
  });
  it('#TRIG-3 N=1 obsDays=90 trades=30 prior=null → T0', () => {
    assert.equal(selectCellWeightsTier(1, 90, 30, null), 'T0');
  });
  it('#TRIG-4 N=2 obsDays=90 trades=30 prior=null → T1 (at thresholds)', () => {
    assert.equal(selectCellWeightsTier(2, 90, 30, null), 'T1');
  });
  it('#TRIG-5 N=4 obsDays=180 trades=60 prior=null → T2', () => {
    assert.equal(selectCellWeightsTier(4, 180, 60, null), 'T2');
  });
  it('#TRIG-6 N=4 obsDays=179 trades=60 prior=null → T1 (T2 obsDays below)', () => {
    assert.equal(selectCellWeightsTier(4, 179, 60, null), 'T1');
  });
  it('#TRIG-7 N=3 obsDays=180 trades=60 prior=null → T1 (T2 N below)', () => {
    assert.equal(selectCellWeightsTier(3, 180, 60, null), 'T1');
  });
  it('#TRIG-8 prior=T1 + thin sample → T1 (ratchet holds)', () => {
    assert.equal(selectCellWeightsTier(2, 30, 10, 'T1'), 'T1');
  });
  it('#TRIG-9 prior=T2 + thin sample at N=4 → T2 (ratchet holds)', () => {
    assert.equal(selectCellWeightsTier(4, 30, 10, 'T2'), 'T2');
  });
  it('#TRIG-10 N=4 obsDays=180 trades=60 prior=T2 → T2', () => {
    assert.equal(selectCellWeightsTier(4, 180, 60, 'T2'), 'T2');
  });
  it('#TRIG-11 prior=T0 → trigger upgrades to T1', () => {
    assert.equal(selectCellWeightsTier(2, 90, 30, 'T0'), 'T1');
  });
  it('#TRIG-12 unknown priorActiveTier string → throws (M-1, parity with Python)', () => {
    // M-1 critic-fix (session 72): TS used to silently return triggerSays
    // when priorActiveTier was an unrecognized string (e.g. from a CH read
    // that bypassed the type system). Python `select_tier` KeyErrors on the
    // same input. Both now reject — the guard is in cell_weights.ts.
    assert.throws(
      () => selectCellWeightsTier(2, 90, 30, 'TX' as unknown as CellWeightsTier),
      /unknown priorActiveTier/,
    );
  });
});

describe('computeCellWeights — TRIG-DATA + RATCHET-N-CHANGE', () => {
  it('#TRIG-DATA (28a, H-1 byte-pin) — 180-day zero-filled series with only 3 observedDays → T0', () => {
    // Critical regression guard: pre-fix the trigger checked
    // dailyReturns[k].length (always 180 after zero-fill), so a 3-day-old
    // paper deployment would have tripped T1 on day 1. Post-fix the trigger
    // checks observedDays.
    const series = new Array(180).fill(0);
    series[0] = 0.001;
    series[1] = -0.001;
    series[2] = 0.002;
    const r = computeCellWeights({
      cellKeys: ['a', 'b'],
      dailyReturns: new Map([['a', series], ['b', series]]),
      closedTradeCounts: new Map([['a', 5], ['b', 5]]),
      observedDays: new Map([['a', 3], ['b', 3]]),
      tier: 'auto',
      priorActiveTier: null,
    });
    assert.equal(r.tierActive, 'T0');
    assert.equal(r.observedDaysWithTrades, 3);
  });

  it('#RATCHET-N-CHANGE (28b) — N drops 4→2 with prior=T2 → T2 holds (HRP at N=2 = IVW)', () => {
    // Build two cells with different variances; T2 at N=2 collapses to IVW.
    const a = seriesWithVariance(1.0, 180);
    const b = seriesWithVariance(2.0, 180);
    const r = computeCellWeights({
      cellKeys: ['a', 'b'],
      dailyReturns: new Map([['a', a], ['b', b]]),
      closedTradeCounts: new Map([['a', 60], ['b', 60]]),
      observedDays: new Map([['a', 180], ['b', 180]]),
      tier: 'auto',
      priorActiveTier: 'T2',
    });
    assert.equal(r.tierActive, 'T2');
    // HRP at N=2 collapses to IVW: w_a ≈ 2/3, w_b ≈ 1/3.
    assert.ok(Math.abs(r.weights.get('a')! - 2 / 3) < APPROX_TOL);
    assert.ok(Math.abs(r.weights.get('b')! - 1 / 3) < APPROX_TOL);
  });
});

// ---------------------------------------------------------------------------
// AUTO-tier dispatch (#AUTO-1..AUTO-3)
// ---------------------------------------------------------------------------
describe('computeCellWeights — auto-tier with ratchet', () => {
  it('#AUTO-1 auto + prior=T1 + thin sample → T1 with ratchetHeld=true', () => {
    // Need ≥2 elements per series for ddof=1 variance.
    const a = seriesWithVariance(1.0, 30);
    const b = seriesWithVariance(2.0, 30);
    // Pad to 180 with zeros (zero-fill convention).
    const pad = (s: number[]): number[] => [...new Array(150).fill(0), ...s];
    const r = computeCellWeights({
      cellKeys: ['a', 'b'],
      dailyReturns: new Map([['a', pad(a)], ['b', pad(b)]]),
      closedTradeCounts: new Map([['a', 20], ['b', 20]]),
      observedDays: new Map([['a', 30], ['b', 30]]),
      tier: 'auto',
      priorActiveTier: 'T1',
    });
    assert.equal(r.tierActive, 'T1');
    assert.equal(r.ratchetHeld, true);
  });

  it('#AUTO-2 auto + prior=null + at-threshold → T1 with ratchetHeld=false', () => {
    const a = seriesWithVariance(1.0, 180);
    const b = seriesWithVariance(2.0, 180);
    const r = computeCellWeights({
      cellKeys: ['a', 'b'],
      dailyReturns: new Map([['a', a], ['b', b]]),
      closedTradeCounts: new Map([['a', 30], ['b', 30]]),
      observedDays: new Map([['a', 90], ['b', 90]]),
      tier: 'auto',
      priorActiveTier: null,
    });
    assert.equal(r.tierActive, 'T1');
    assert.equal(r.ratchetHeld, false);
  });

  it('#AUTO-3 auto + prior=null + thin (T=5) → T0', () => {
    const series = [...new Array(175).fill(0), 0.01, -0.01, 0.02, -0.02, 0.01];
    const r = computeCellWeights({
      cellKeys: ['a', 'b'],
      dailyReturns: new Map([['a', series], ['b', series]]),
      closedTradeCounts: new Map([['a', 5], ['b', 5]]),
      observedDays: new Map([['a', 5], ['b', 5]]),
      tier: 'auto',
      priorActiveTier: null,
    });
    assert.equal(r.tierActive, 'T0');
    assert.equal(r.ratchetHeld, false);
  });
});

// ---------------------------------------------------------------------------
// EDGE-case throws (#EDGE-1..EDGE-5 + 36a EDGE-6)
// ---------------------------------------------------------------------------
describe('computeCellWeights — edge-case throws (SPEC §7)', () => {
  it('#EDGE-1 empty cellKeys → throws', () => {
    assert.throws(
      () => computeCellWeights({
        cellKeys: [],
        dailyReturns: new Map(),
        closedTradeCounts: new Map(),
        observedDays: new Map(),
        tier: 'T0',
        priorActiveTier: null,
      }),
      /cellKeys/i,
    );
  });

  it('#EDGE-2 duplicate cellKeys → throws', () => {
    assert.throws(
      () => computeCellWeights({
        cellKeys: ['a', 'a'],
        dailyReturns: new Map([['a', [0]]]),
        closedTradeCounts: new Map([['a', 0]]),
        observedDays: new Map([['a', 0]]),
        tier: 'T0',
        priorActiveTier: null,
      }),
      /duplicate/i,
    );
  });

  it('#EDGE-3 missing cellKey from dailyReturns → throws', () => {
    assert.throws(
      () => computeCellWeights({
        cellKeys: ['a', 'b'],
        dailyReturns: new Map([['a', [0]]]),
        closedTradeCounts: new Map([['a', 0], ['b', 0]]),
        observedDays: new Map([['a', 0], ['b', 0]]),
        tier: 'T0',
        priorActiveTier: null,
      }),
      // The 'size mismatch' error fires first when sizes disagree; either is a SPEC §7 throw.
      /(missing|size|does not match)/i,
    );
  });

  it('#EDGE-4 series length mismatch → throws', () => {
    assert.throws(
      () => computeCellWeights({
        cellKeys: ['a', 'b'],
        dailyReturns: new Map([['a', [0, 0]], ['b', [0]]]),
        closedTradeCounts: new Map([['a', 0], ['b', 0]]),
        observedDays: new Map([['a', 0], ['b', 0]]),
        tier: 'T0',
        priorActiveTier: null,
      }),
      /length/i,
    );
  });

  it('#EDGE-5 non-finite in series → throws', () => {
    assert.throws(
      () => computeCellWeights({
        cellKeys: ['a', 'b'],
        dailyReturns: new Map([['a', [0, NaN]], ['b', [0, 0]]]),
        closedTradeCounts: new Map([['a', 0], ['b', 0]]),
        observedDays: new Map([['a', 0], ['b', 0]]),
        tier: 'T0',
        priorActiveTier: null,
      }),
      /non-finite/i,
    );
  });

  it('#EDGE-6 (36a, M-6 cold-start) — T0 + empty series + zero trades does NOT throw', () => {
    // Most-exercised production state today. Must not throw.
    const r = computeCellWeights({
      cellKeys: ['a', 'b'],
      dailyReturns: new Map([['a', []], ['b', []]]),
      closedTradeCounts: new Map([['a', 0], ['b', 0]]),
      observedDays: new Map([['a', 0], ['b', 0]]),
      tier: 'T0',
      priorActiveTier: null,
    });
    assert.equal(r.tierActive, 'T0');
    assert.equal(r.weights.get('a'), 0.5);
    assert.equal(r.weights.get('b'), 0.5);
    assert.equal(r.observedDaysWithTrades, 0);
  });
});

// ---------------------------------------------------------------------------
// getCellDailyReturns with injected executor (#DATA-1..DATA-4)
// ---------------------------------------------------------------------------
describe('getCellDailyReturns — injected executor', () => {
  const refDate = new Date(Date.UTC(2026, 4, 17));   // 2026-05-17
  // Helper to format a YYYY-MM-DD string for a date N days before refDate.
  function dayBefore(n: number): string {
    const d = new Date(refDate.getTime() - n * 86400000);
    return d.toISOString().slice(0, 10);
  }

  it('#DATA-1 2 cells × 5 days each → zero-filled to length windowDays', async () => {
    const rows = [
      { cell_key: 'a', day: dayBefore(0), realized_pnl_usd: 10, closed_trade_count: 1 },
      { cell_key: 'a', day: dayBefore(1), realized_pnl_usd: 5,  closed_trade_count: 1 },
      { cell_key: 'b', day: dayBefore(0), realized_pnl_usd: -2, closed_trade_count: 1 },
    ];
    const r = await getCellDailyReturns({
      cellKeys: ['a', 'b'],
      windowDays: 10,
      refDate,
      cellCapitalUsdProxy: 1000,
      executor: async () => rows,
    });
    assert.equal(r.dailyReturns.get('a')!.length, 10);
    assert.equal(r.dailyReturns.get('b')!.length, 10);
    // index 9 = refDate; index 8 = refDate-1.
    assert.equal(r.dailyReturns.get('a')![9], 10 / 1000);
    assert.equal(r.dailyReturns.get('a')![8], 5 / 1000);
    assert.equal(r.dailyReturns.get('b')![9], -2 / 1000);
    assert.equal(r.closedTradeCounts.get('a'), 2);
    assert.equal(r.closedTradeCounts.get('b'), 1);
    assert.equal(r.observedDays.get('a'), 2);
    assert.equal(r.observedDays.get('b'), 1);
  });

  it('#DATA-2 only one cell in result → other cell zero-filled, length windowDays', async () => {
    const rows = [
      { cell_key: 'a', day: dayBefore(0), realized_pnl_usd: 1, closed_trade_count: 1 },
    ];
    const r = await getCellDailyReturns({
      cellKeys: ['a', 'b'],
      windowDays: 5,
      refDate,
      cellCapitalUsdProxy: 1000,
      executor: async () => rows,
    });
    assert.equal(r.dailyReturns.get('b')!.length, 5);
    for (const v of r.dailyReturns.get('b')!) assert.equal(v, 0);
    assert.equal(r.observedDays.get('b'), 0);
  });

  it('#DATA-3 rows outside window are silently filtered (helper trusts SQL filter)', async () => {
    const rows = [
      // dayBefore(0) inside window; dayBefore(999) outside → silently dropped.
      { cell_key: 'a', day: dayBefore(0), realized_pnl_usd: 1, closed_trade_count: 1 },
      { cell_key: 'a', day: dayBefore(999), realized_pnl_usd: 100, closed_trade_count: 1 },
    ];
    const r = await getCellDailyReturns({
      cellKeys: ['a'],
      windowDays: 5,
      refDate,
      cellCapitalUsdProxy: 1000,
      executor: async () => rows,
    });
    // Only the in-window row contributes.
    assert.equal(r.closedTradeCounts.get('a'), 1);
    assert.equal(r.observedDays.get('a'), 1);
  });

  it('#DATA-4 result Map iterates in cellKeys input order', async () => {
    const r = await getCellDailyReturns({
      cellKeys: ['zeta', 'alpha'],
      windowDays: 3,
      refDate,
      cellCapitalUsdProxy: 1000,
      executor: async () => [],
    });
    assert.deepEqual(Array.from(r.dailyReturns.keys()), ['zeta', 'alpha']);
    assert.deepEqual(Array.from(r.closedTradeCounts.keys()), ['zeta', 'alpha']);
    assert.deepEqual(Array.from(r.observedDays.keys()), ['zeta', 'alpha']);
  });
});

// ---------------------------------------------------------------------------
// formatCellWeightsLogLine — byte-pin (#LOG-1..LOG-4)
// ---------------------------------------------------------------------------
describe('formatCellWeightsLogLine — byte-pinned format (SPEC §9.5)', () => {
  it('#LOG-1 T0 N=2', () => {
    const line = formatCellWeightsLogLine({
      tierActive: 'T0',
      weights: new Map([['mr_v1', 0.5], ['trend_v1', 0.5]]),
      observedDaysWithTrades: 0,
      observedMinClosedTrades: 0,
      ratchetHeld: false,
    });
    assert.equal(
      line,
      `[cell-weights] tier=T0 cells=2 weights=mr_v1:0.500,trend_v1:0.500 obsDaysWithTrades=0 minClosedTrades=0 ratchetHeld=no`,
    );
  });

  it('#LOG-2 T1 N=2 weights {0.667, 0.333}', () => {
    const line = formatCellWeightsLogLine({
      tierActive: 'T1',
      weights: new Map([['mean_reversion_v1__p14', 2 / 3], ['trend_v1__p30', 1 / 3]]),
      observedDaysWithTrades: 92,
      observedMinClosedTrades: 42,
      ratchetHeld: false,
    });
    assert.equal(
      line,
      `[cell-weights] tier=T1 cells=2 weights=mean_reversion_v1__p14:0.667,trend_v1__p30:0.333 obsDaysWithTrades=92 minClosedTrades=42 ratchetHeld=no`,
    );
  });

  it('#LOG-3 ratchetHeld → trailing yes', () => {
    const line = formatCellWeightsLogLine({
      tierActive: 'T1',
      weights: new Map([['a', 0.5], ['b', 0.5]]),
      observedDaysWithTrades: 30,
      observedMinClosedTrades: 10,
      ratchetHeld: true,
    });
    assert.match(line, /ratchetHeld=yes$/);
  });

  it('#LOG-4 DEGRADED suffix', () => {
    const line = formatCellWeightsLogLine({
      tierActive: 'T0',
      weights: new Map([['a', 0.5], ['b', 0.5]]),
      observedDaysWithTrades: 0,
      observedMinClosedTrades: 0,
      ratchetHeld: false,
      degraded: true,
    });
    assert.ok(line.endsWith('  (DEGRADED: CH unavailable)'), `got: ${line}`);
  });
});

// ---------------------------------------------------------------------------
// resolveCellWeightsForRun — orchestration (#ORCH-1..ORCH-3)
// ---------------------------------------------------------------------------
describe('resolveCellWeightsForRun — orchestration with injected fetchDailyReturns', () => {
  it('#ORCH-1 happy-path T1 → tierActive=T1, weights computed against fetched series', async () => {
    const series_a = seriesWithVariance(1.0, 180);
    const series_b = seriesWithVariance(2.0, 180);
    const r: ResolveCellWeightsResult = await resolveCellWeightsForRun({
      cellKeys: ['a', 'b'],
      refDate: new Date(),
      cellCapitalUsdProxy: 1000,
      priorActiveTier: null,
      fetchDailyReturns: async () => ({
        dailyReturns: new Map([['a', series_a], ['b', series_b]]),
        closedTradeCounts: new Map([['a', 100], ['b', 100]]),
        observedDays: new Map([['a', 100], ['b', 100]]),
      }),
    });
    assert.equal(r.tierActive, 'T1');
    assert.equal(r.degraded, false);
    assert.ok(Math.abs(r.weights.get('a')! - 2 / 3) < APPROX_TOL);
  });

  it('#ORCH-2 fetchDailyReturns throws → tierActive=T0 with DEGRADED log suffix', async () => {
    const r = await resolveCellWeightsForRun({
      cellKeys: ['a', 'b'],
      refDate: new Date(),
      cellCapitalUsdProxy: 1000,
      priorActiveTier: 'T1',  // even with prior=T1, DEGRADED path forces T0
      fetchDailyReturns: async () => { throw new Error('CH outage'); },
    });
    assert.equal(r.tierActive, 'T0');
    assert.equal(r.degraded, true);
    assert.ok(r.logLine.endsWith('  (DEGRADED: CH unavailable)'));
    assert.equal(r.weights.get('a'), 0.5);
    assert.equal(r.weights.get('b'), 0.5);
  });

  it('#ORCH-3 priorActiveTier=T1 honored through ratchet under thin sample', async () => {
    // Same as AUTO-1 but routed via the orchestrator with injected fetcher.
    const a = seriesWithVariance(1.0, 30);
    const b = seriesWithVariance(2.0, 30);
    const pad = (s: number[]) => [...new Array(150).fill(0), ...s];
    const r = await resolveCellWeightsForRun({
      cellKeys: ['a', 'b'],
      refDate: new Date(),
      cellCapitalUsdProxy: 1000,
      priorActiveTier: 'T1',
      fetchDailyReturns: async () => ({
        dailyReturns: new Map([['a', pad(a)], ['b', pad(b)]]),
        closedTradeCounts: new Map([['a', 20], ['b', 20]]),
        observedDays: new Map([['a', 30], ['b', 30]]),
      }),
    });
    assert.equal(r.tierActive, 'T1');
    assert.equal(r.ratchetHeld, true);
  });
});

// ---------------------------------------------------------------------------
// DEGRADED-RATCHET (#50c, H-2 byte-pin) — three-run sequence.
// ---------------------------------------------------------------------------
describe('resolveCellWeightsForRun — DEGRADED rows do not poison ratchet (SPEC §11.2)', () => {
  it('#50c DEGRADED-RATCHET — run2 degraded, but §11.2 lookup filters degraded=0 and returns T1 for run3', async () => {
    // Step 1: run 1 — prior=null, fetch succeeds with T1-eligible data.
    const a = seriesWithVariance(1.0, 180);
    const b = seriesWithVariance(2.0, 180);
    const fetcherOk = async () => ({
      dailyReturns: new Map([['a', a], ['b', b]]),
      closedTradeCounts: new Map([['a', 100], ['b', 100]]),
      observedDays: new Map([['a', 100], ['b', 100]]),
    });
    const r1 = await resolveCellWeightsForRun({
      cellKeys: ['a', 'b'],
      refDate: new Date('2026-05-17'),
      cellCapitalUsdProxy: 1000,
      priorActiveTier: null,
      fetchDailyReturns: fetcherOk,
    });
    assert.equal(r1.tierActive, 'T1');
    assert.equal(r1.degraded, false);

    // Step 2: run 2 — fetch THROWS → DEGRADED row, tierActive=T0.
    const r2 = await resolveCellWeightsForRun({
      cellKeys: ['a', 'b'],
      refDate: new Date('2026-05-18'),
      cellCapitalUsdProxy: 1000,
      priorActiveTier: r1.tierActive,
      fetchDailyReturns: async () => { throw new Error('CH outage'); },
    });
    assert.equal(r2.tierActive, 'T0');
    assert.equal(r2.degraded, true);

    // Step 3: simulate the §11.2 prior-tier lookup — filter degraded=0 from
    // the persisted rows [r1: degraded=0 tier='T1', r2: degraded=1 tier='T0'].
    // The lookup returns the most recent NON-degraded row's tier → 'T1'.
    const persisted = [
      { run_ts: '2026-05-17', tier_active: r1.tierActive, degraded: r1.degraded },
      { run_ts: '2026-05-18', tier_active: r2.tierActive, degraded: r2.degraded },
    ];
    const lookupResult = persisted
      .filter(p => !p.degraded)
      .sort((x, y) => y.run_ts.localeCompare(x.run_ts))[0]?.tier_active ?? null;
    assert.equal(lookupResult, 'T1', 'The §11.2 WHERE degraded=0 filter is load-bearing');

    // Step 4: run 3 — fetch succeeds again. Prior tier from the §11.2-style
    // lookup is 'T1', so the ratchet correctly resumes from where it was
    // before the outage even though the immediately-preceding run was T0.
    const r3 = await resolveCellWeightsForRun({
      cellKeys: ['a', 'b'],
      refDate: new Date('2026-05-19'),
      cellCapitalUsdProxy: 1000,
      priorActiveTier: lookupResult as 'T1',
      fetchDailyReturns: fetcherOk,
    });
    assert.equal(r3.tierActive, 'T1');
    assert.equal(r3.ratchetHeld, false); // sample is still T1-eligible
  });
});

// ---------------------------------------------------------------------------
// Migration smoke test (#56)
// ---------------------------------------------------------------------------
describe('migrate_cell_weights_history — DDL constant', () => {
  it('#56 DDL is CREATE TABLE IF NOT EXISTS quantlab.cell_weights_history with ReplacingMergeTree(version)', () => {
    assert.match(DDL_CELL_WEIGHTS_HISTORY, /CREATE TABLE IF NOT EXISTS quantlab\.cell_weights_history/);
    assert.match(DDL_CELL_WEIGHTS_HISTORY, /ENGINE = ReplacingMergeTree\(version\)/);
    assert.match(DDL_CELL_WEIGHTS_HISTORY, /ORDER BY \(ref_date, daemon_run_id\)/);
    assert.match(DDL_CELL_WEIGHTS_HISTORY, /degraded\s+UInt8/);
  });
});

// ---------------------------------------------------------------------------
// Sanity — TIER_TRIGGERS constants match SPEC §3.
// ---------------------------------------------------------------------------
describe('TIER_TRIGGERS — SPEC §3 constants', () => {
  it('T1 minN=2 minDaysWithTrades=90 minClosedTrades=30', () => {
    assert.equal(TIER_TRIGGERS.T1.minN, 2);
    assert.equal(TIER_TRIGGERS.T1.minDaysWithTrades, 90);
    assert.equal(TIER_TRIGGERS.T1.minClosedTrades, 30);
  });
  it('T2 minN=4 minDaysWithTrades=180 minClosedTrades=60', () => {
    assert.equal(TIER_TRIGGERS.T2.minN, 4);
    assert.equal(TIER_TRIGGERS.T2.minDaysWithTrades, 180);
    assert.equal(TIER_TRIGGERS.T2.minClosedTrades, 60);
  });
});

// ---------------------------------------------------------------------------
// #TIER-PARITY (L-2, session 72) — Python↔TS byte-pin for selectCellWeightsTier.
// ---------------------------------------------------------------------------
//
// The 11 TRIG-* tests above pin specific scenarios but only verify TS-against-
// TS. Session 70's HRP path is byte-pinned against scipy via 5 fixtures; the
// tier-selection logic deserves the same discipline. This block loads a
// Cartesian fixture generated by
//   .venv/Scripts/python.exe scripts/_compute_cell_weights_reference.py --gen-tier-fixtures
// (720 scenarios = 5 N × 6 days × 6 trades × 4 priors) and asserts that
// `selectCellWeightsTier` matches the Python `select_tier` reference on every
// row. Any future change to either implementation that drifts the two surfaces
// fails this test with the exact scenario tuple in the diagnostic.
//
// Watch-out: the fixture is generated by the Python reference; if a future
// SPEC amendment changes the trigger thresholds (TIER_TRIGGERS), the operator
// MUST re-run `--gen-tier-fixtures` to refresh the fixture in lockstep with
// the TS constant change. Stale fixture → test fails. This is by design.
// ---------------------------------------------------------------------------
describe('selectCellWeightsTier — TIER-PARITY (Python byte-pin)', () => {
  interface TierScenario {
    observedN: number;
    observedDaysWithTrades: number;
    observedMinClosedTrades: number;
    priorActiveTier: CellWeightsTier | null;
    expectedTier: CellWeightsTier;
    sufficientForT1: boolean;
    sufficientForT2: boolean;
  }
  interface TierFixture {
    id: string;
    scenarioCount: number;
    scenarios: TierScenario[];
  }

  const fixturePath = join(
    process.cwd(),
    'scripts/tests/fixtures/cell_weights/tier_selection_parity.json',
  );
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as TierFixture;

  it('#TIER-PARITY-META fixture is well-formed (all four priors, all three tiers present)', () => {
    assert.equal(fixture.id, 'tier_selection_parity');
    assert.equal(fixture.scenarios.length, fixture.scenarioCount);
    const priors = new Set(fixture.scenarios.map(s => s.priorActiveTier));
    assert.equal(priors.size, 4);
    for (const p of [null, 'T0', 'T1', 'T2'] as const) assert.ok(priors.has(p));
    // Distribution sanity — every tier appears at least once.
    const tiers = new Set(fixture.scenarios.map(s => s.expectedTier));
    for (const t of ['T0', 'T1', 'T2'] as const) assert.ok(tiers.has(t), `expected ${t} in fixture`);
  });

  it('#TIER-PARITY all scenarios — TS selectCellWeightsTier matches Python', () => {
    const mismatches: Array<{ scenario: TierScenario; got: CellWeightsTier }> = [];
    for (const s of fixture.scenarios) {
      const got = selectCellWeightsTier(
        s.observedN,
        s.observedDaysWithTrades,
        s.observedMinClosedTrades,
        s.priorActiveTier,
      );
      if (got !== s.expectedTier) mismatches.push({ scenario: s, got });
    }
    if (mismatches.length > 0) {
      // Surface the first 5 divergences — enough to recognize a pattern
      // (e.g. an off-by-one at one specific threshold) without flooding.
      const sample = mismatches.slice(0, 5).map(m => {
        const s = m.scenario;
        return (
          `  N=${s.observedN} days=${s.observedDaysWithTrades} ` +
          `trades=${s.observedMinClosedTrades} prior=${s.priorActiveTier} ` +
          `→ TS=${m.got} Py=${s.expectedTier}`
        );
      });
      assert.fail(
        `TIER-PARITY: ${mismatches.length}/${fixture.scenarios.length} scenarios diverge.\n` +
          `First ${Math.min(5, mismatches.length)}:\n${sample.join('\n')}\n` +
          `Regenerate fixture if TIER_TRIGGERS intentionally changed:\n` +
          `  .venv/Scripts/python.exe scripts/_compute_cell_weights_reference.py --gen-tier-fixtures`,
      );
    }
  });

  // M-2 (critic-fix this session) — the fixture also pins
  // `sufficientForT1` / `sufficientForT2`, which `computeCellWeights` exposes
  // on `ComputeCellWeightsResult`. Leaving them unasserted would be a silent
  // tripwire: a future drift between the TS sufficiency-flag computation and
  // the Python `select_tier` definition would not surface anywhere. This
  // synthesizes a minimal T0-forced compute (so the math path is short-
  // circuited) and checks only the flags.
  it('#TIER-PARITY-SUFFICIENCY sufficiency flags agree with Python on all scenarios', () => {
    const mismatches: Array<{ scenario: TierScenario; gotT1: boolean; gotT2: boolean }> = [];
    // Reuse the same series across scenarios — the T0-forced path doesn't
    // touch dailyReturns math, so a single trivial series suffices.
    const trivialSeries = [0];
    for (const s of fixture.scenarios) {
      if (s.observedN < 1) continue; // computeCellWeights throws on N=0; sweep starts at 1.
      const keys = Array.from({ length: s.observedN }, (_, i) => `c${i}`);
      const dailyReturns = new Map(keys.map(k => [k, trivialSeries]));
      const closedTradeCounts = new Map(keys.map(k => [k, s.observedMinClosedTrades]));
      const observedDays = new Map(keys.map(k => [k, s.observedDaysWithTrades]));
      const r = computeCellWeights({
        cellKeys: keys,
        dailyReturns,
        closedTradeCounts,
        observedDays,
        tier: 'T0', // force T0 so no variance computation runs.
        priorActiveTier: s.priorActiveTier,
      });
      if (r.sufficientForT1 !== s.sufficientForT1 || r.sufficientForT2 !== s.sufficientForT2) {
        mismatches.push({ scenario: s, gotT1: r.sufficientForT1, gotT2: r.sufficientForT2 });
      }
    }
    if (mismatches.length > 0) {
      const sample = mismatches.slice(0, 5).map(m => {
        const s = m.scenario;
        return (
          `  N=${s.observedN} days=${s.observedDaysWithTrades} ` +
          `trades=${s.observedMinClosedTrades} ` +
          `→ TS T1=${m.gotT1} T2=${m.gotT2} | ` +
          `Py T1=${s.sufficientForT1} T2=${s.sufficientForT2}`
        );
      });
      assert.fail(
        `TIER-PARITY-SUFFICIENCY: ${mismatches.length} scenarios diverge.\n` +
          sample.join('\n'),
      );
    }
  });
});
