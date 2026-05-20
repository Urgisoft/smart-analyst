/**
 * Tests for src/server/etf_flow.ts — pure-function composite (Phase A2).
 *
 * SPEC: docs/specs/etf-flow-monitoring.md §§5, 9.1 (T-EF-1..T-EF-20).
 *
 * No CH dependency; in-memory composite tests only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ETF_FLOW_COMPOSITE_VERSION,
  FLOW_WINDOW_BD,
  MIN_Z_BASELINE,
  DIVERGENCE_Z_THRESHOLD,
  SECTOR_FLOW_DISPERSION_THRESHOLD,
  AGGREGATE_RISK_ON_FLOW_Z_THRESHOLD,
  FLAGGED_ETFS_ABS_Z_THRESHOLD,
  BROAD_INDEX_ETFS,
  SPDR_SECTOR_ETFS,
  STYLE_RISK_ETFS,
  ETF_UNIVERSE,
  resolveEtfGroup,
  computeFlowShares20bd,
  computeFlowDollar20bd,
  computeFlowPctAum,
  computeReturn20bd,
  computeZ,
  flagDivergence,
  computeSectorFlowDispersion,
  computeAggregateRiskOnFlow,
  flagAggregateFlowStress,
  evaluateEtfFlowComposite,
  type EtfFlowPerEtfInput,
  type EtfFlowInputs,
} from '../../src/server/etf_flow.js';

const ASOF = new Date('2026-05-19T12:00:00Z');

/** Floating-point-tolerant equality. */
function assertClose(actual: number | null, expected: number, eps = 1e-9): void {
  assert.ok(actual != null, `expected ${expected}, got null`);
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected close to ${expected}, got ${actual} (delta ${Math.abs(actual - expected)})`,
  );
}

/** Build a flat 21-element series at a constant value (helper for fixtures). */
function constArr(n: number, v: number): number[] {
  return Array.from({ length: n }, () => v);
}

/** Build a 21-element shares panel with a step-change pattern. */
function sharesStep(
  startShares: number,
  endShares: number,
  startIdx: number,
): number[] {
  const out: number[] = new Array(FLOW_WINDOW_BD + 1).fill(startShares);
  for (let i = startIdx; i <= FLOW_WINDOW_BD; i++) out[i] = endShares;
  return out;
}

/** Build a synthetic per-ETF input row. */
function makePerEtf(overrides: Partial<EtfFlowPerEtfInput> = {}): EtfFlowPerEtfInput {
  return {
    ticker: overrides.ticker ?? 'SPY',
    shares21: overrides.shares21 ?? constArr(FLOW_WINDOW_BD + 1, 1000),
    closes21: overrides.closes21 ?? constArr(FLOW_WINDOW_BD + 1, 400),
    baseline1yFlowPctAum: overrides.baseline1yFlowPctAum ?? [],
    baseline1yReturn20bd: overrides.baseline1yReturn20bd ?? [],
    bdSinceShareUpdate: overrides.bdSinceShareUpdate ?? 0,
  };
}

/** Build composite inputs with overrides. */
function makeInputs(overrides: Partial<EtfFlowInputs> = {}): EtfFlowInputs {
  return {
    asOf: ASOF,
    lastYfinanceQueryAt: new Date('2026-05-19T08:00:00Z'),
    perEtf: [],
    ...overrides,
  };
}

// ── T-EF-1: flow_shares_20bd computed correctly ─────────────────────────────

describe('computeFlowShares20bd (T-EF-1)', () => {
  it('shares_t = 1000, shares_{t-20bd} = 950 → flow = 50', () => {
    assert.equal(computeFlowShares20bd(1000, 950), 50);
  });
  it('handles outflow correctly (negative flow)', () => {
    assert.equal(computeFlowShares20bd(900, 1000), -100);
  });
  it('zero flow when shares unchanged', () => {
    assert.equal(computeFlowShares20bd(1000, 1000), 0);
  });
});

// ── T-EF-2: flow_dollar_20bd is sum-of-daily, NOT (Δshares × close_t) ───────

describe('computeFlowDollar20bd (T-EF-2)', () => {
  it('sum-of-daily attribution differs from end-of-window approximation', () => {
    // Construct a scenario where shares grow by 100 over 20bd, but the growth
    // is split into two pulses at different prices:
    //   - +60 shares at day 5 (close = 100)
    //   - +40 shares at day 15 (close = 200)
    // Correct attribution: 60*100 + 40*200 = 6000 + 8000 = 14000
    // Naive (Δ × close_t at close_t=200): 100 * 200 = 20000  (WRONG)
    const shares = constArr(FLOW_WINDOW_BD + 1, 1000);
    for (let i = 5; i < shares.length; i++) shares[i] = 1060;
    for (let i = 15; i < shares.length; i++) shares[i] = 1100;

    const closes = constArr(FLOW_WINDOW_BD + 1, 100);
    for (let i = 15; i < closes.length; i++) closes[i] = 200;

    const flow = computeFlowDollar20bd(shares, closes);
    // Daily diffs: i=5 contributes (1060-1000)*100 = 6000; i=15 contributes
    // (1100-1060)*200 = 8000; all other i contribute 0.
    assertClose(flow, 14000);

    // Naive end-of-window approximation:
    const naive = (1100 - 1000) * 200;
    assert.notEqual(flow, naive, 'sum-of-daily must differ from naive (Δs × close_t)');
  });

  it('throws on wrong panel length (defensive — fail-loud per Vector Core)', () => {
    assert.throws(
      () => computeFlowDollar20bd([1, 2, 3], constArr(FLOW_WINDOW_BD + 1, 100)),
      /shares array must have 21 elements/,
    );
    assert.throws(
      () => computeFlowDollar20bd(constArr(FLOW_WINDOW_BD + 1, 1000), [1, 2, 3]),
      /closes array must have 21 elements/,
    );
  });
});

// ── T-EF-3: flow_pct_aum_t = flow_dollar_20bd / (shares_t × close_t) ────────

describe('computeFlowPctAum (T-EF-3)', () => {
  it('correctly computes % of AUM', () => {
    assertClose(computeFlowPctAum(1_000_000, 1000, 400), 1_000_000 / 400_000);
  });
  it('handles negative flow (outflow)', () => {
    assertClose(computeFlowPctAum(-500_000, 1000, 400), -1.25);
  });
  it('returns null when AUM = 0 (degenerate)', () => {
    assert.equal(computeFlowPctAum(1000, 0, 400), null);
    assert.equal(computeFlowPctAum(1000, 1000, 0), null);
  });
});

// ── T-EF-4: flow_z null when baseline < 30 prints (cold-start) ──────────────

describe('computeZ baseline floor (T-EF-4)', () => {
  it('returns null z when baseline has fewer than MIN_Z_BASELINE prints', () => {
    const baseline = Array.from({ length: MIN_Z_BASELINE - 1 }, (_, i) => i / 100);
    const result = computeZ(0.05, baseline);
    assert.equal(result.z, null);
    assert.equal(result.baselineSize, MIN_Z_BASELINE - 1);
  });
  it('returns null z when value is null', () => {
    const baseline = Array.from({ length: 50 }, (_, i) => i / 100);
    assert.equal(computeZ(null, baseline).z, null);
  });
});

// ── T-EF-5: flow_z with 30+ prints, known mean/stddev fixture ──────────────

describe('computeZ with 30+ prints (T-EF-5)', () => {
  it('computes z to ε precision for a known mean/stddev baseline', () => {
    // Build a baseline of 100 values uniformly in [-0.01, 0.01]; symmetric → mean ≈ 0
    const baseline: number[] = [];
    for (let i = 0; i < 100; i++) {
      // values: -0.01, -0.0098, ..., +0.01 step 0.0002 (101 vals; use 100)
      baseline.push(-0.01 + i * (0.02 / 99));
    }
    const result = computeZ(0.05, baseline);
    assert.ok(result.z != null);
    // Compute expected: mean of baseline + sample stddev
    const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
    let sq = 0;
    for (const v of baseline) sq += (v - mean) ** 2;
    const stddev = Math.sqrt(sq / (baseline.length - 1));
    const expected = (0.05 - mean) / stddev;
    assertClose(result.z, expected);
    assert.equal(result.baselineSize, 100);
  });
});

// ── T-EF-6: return_z_20bd cold-start parity with flow_z ─────────────────────

describe('computeZ cold-start parity for return_z (T-EF-6)', () => {
  it('return_z_20bd null cold-start mirrors flow_z null cold-start', () => {
    const baseline = Array.from({ length: 20 }, (_, i) => i * 0.01);
    const flowResult = computeZ(0.05, baseline);
    const returnResult = computeZ(0.03, baseline);
    assert.equal(flowResult.z, null);
    assert.equal(returnResult.z, null);
  });
  it('return_z is meaningful once baseline crosses MIN_Z_BASELINE', () => {
    // Build a non-degenerate baseline (mean 0, stddev > 0)
    const baseline: number[] = [];
    for (let i = 0; i < 60; i++) baseline.push((i % 5 - 2) * 0.005);
    const result = computeZ(0.05, baseline);
    assert.ok(result.z != null);
    assert.ok(result.z > 0);
  });
});

// ── T-EF-7: divergence_flag fires on (flow_z=+1.5, return_z=-1.5) ──────────

describe('flagDivergence — opposite signs both |z|>1 (T-EF-7)', () => {
  it('fires on (+1.5, -1.5) — inflow vs price drop', () => {
    assert.equal(flagDivergence(1.5, -1.5), true);
  });
  it('fires on (-1.5, +1.5) — outflow vs price rise', () => {
    assert.equal(flagDivergence(-1.5, 1.5), true);
  });
  it('fires on (+1.01, -1.01) — barely over threshold both sides', () => {
    assert.equal(flagDivergence(1.01, -1.01), true);
  });
});

// ── T-EF-8: divergence does NOT fire when one magnitude is small ────────────

describe('flagDivergence — magnitude guard (T-EF-8)', () => {
  it('does NOT fire on (+1.5, -0.5) — return_z magnitude below threshold', () => {
    assert.equal(flagDivergence(1.5, -0.5), false);
  });
  it('does NOT fire on (+0.5, -1.5) — flow_z magnitude below threshold', () => {
    assert.equal(flagDivergence(0.5, -1.5), false);
  });
  it('does NOT fire on (+1.0, -1.0) — exact-threshold non-strict', () => {
    // The check is strict > 1, not >= 1.
    assert.equal(flagDivergence(1.0, -1.0), false);
  });
});

// ── T-EF-9: divergence does NOT fire when signs agree ─────────────────────

describe('flagDivergence — same signs no divergence (T-EF-9)', () => {
  it('does NOT fire on (+1.5, +1.5) — both inflow + price rise', () => {
    assert.equal(flagDivergence(1.5, 1.5), false);
  });
  it('does NOT fire on (-1.5, -1.5) — both outflow + price drop', () => {
    assert.equal(flagDivergence(-1.5, -1.5), false);
  });
});

// ── T-EF-10: divergence_flag false when either z null (cold-start) ──────────

describe('flagDivergence — cold-start (T-EF-10)', () => {
  it('returns false when flow_z is null', () => {
    assert.equal(flagDivergence(null, -1.5), false);
  });
  it('returns false when return_z is null', () => {
    assert.equal(flagDivergence(1.5, null), false);
  });
  it('returns false when both are null', () => {
    assert.equal(flagDivergence(null, null), false);
  });
});

// ── T-EF-11: sector_flow_dispersion = stddev across 11 SPDR sector ETFs ────

describe('computeSectorFlowDispersion (T-EF-11)', () => {
  it('returns population stddev (divide by N) across exactly 11 z-scores', () => {
    // Known fixture: z-scores [-2, -1, 0, 1, 2, 0, 0, 0, 0, 0, 0]; mean = 0; population variance = (4+1+0+1+4)/11 = 10/11
    const zs = [-2, -1, 0, 1, 2, 0, 0, 0, 0, 0, 0];
    const expected = Math.sqrt(10 / 11);
    assertClose(computeSectorFlowDispersion(zs), expected);
  });
  it('returns 0 for an all-identical cross-section (no spread)', () => {
    const zs = constArr(11, 1.0);
    assertClose(computeSectorFlowDispersion(zs), 0);
  });
});

// ── T-EF-12: sector_flow_dispersion = null when any sector ETF z is null ───

describe('computeSectorFlowDispersion cold-start (T-EF-12)', () => {
  it('returns null when one element is null', () => {
    const zs: (number | null)[] = [0, 1, 2, null, 0, 0, 0, 0, 0, 0, 0];
    assert.equal(computeSectorFlowDispersion(zs), null);
  });
  it('returns null when input array is empty', () => {
    assert.equal(computeSectorFlowDispersion([]), null);
  });
  it('returns null when an element is NaN', () => {
    const zs: (number | null)[] = [0, 1, 2, NaN, 0, 0, 0, 0, 0, 0, 0];
    assert.equal(computeSectorFlowDispersion(zs), null);
  });
});

// ── T-EF-13: aggregate_risk_on_flow = mean across 6 broad-index ETFs ───────

describe('computeAggregateRiskOnFlow (T-EF-13)', () => {
  it('returns arithmetic mean across exactly 6 z-scores', () => {
    const zs = [1, 2, 3, 4, 5, 6];
    assertClose(computeAggregateRiskOnFlow(zs), 21 / 6);
  });
  it('handles negative z-scores symmetrically', () => {
    const zs = [-1, -1, -1, 1, 1, 1];
    assertClose(computeAggregateRiskOnFlow(zs), 0);
  });
});

// ── T-EF-14: aggregate_risk_on_flow = null when any broad ETF z is null ────

describe('computeAggregateRiskOnFlow cold-start (T-EF-14)', () => {
  it('returns null when one element is null', () => {
    const zs: (number | null)[] = [1, 1, null, 1, 1, 1];
    assert.equal(computeAggregateRiskOnFlow(zs), null);
  });
  it('returns null when input array is empty', () => {
    assert.equal(computeAggregateRiskOnFlow([]), null);
  });
});

// ── T-EF-15: aggregate_flow_stress_flag fires when dispersion > 2.0 ────────

describe('flagAggregateFlowStress — dispersion arm (T-EF-15)', () => {
  it('fires when sector_flow_dispersion > 2.0', () => {
    assert.equal(flagAggregateFlowStress(2.5, 0.5), true);
  });
  it('does NOT fire when dispersion is exactly 2.0 (strict-greater-than)', () => {
    assert.equal(flagAggregateFlowStress(2.0, 0.5), false);
  });
  it('does NOT fire when dispersion is below threshold', () => {
    assert.equal(flagAggregateFlowStress(1.9, 0.5), false);
  });
});

// ── T-EF-16: aggregate_flow_stress_flag fires when |risk_on| > 2.0 ─────────

describe('flagAggregateFlowStress — risk-on arm (T-EF-16)', () => {
  it('fires on positive |risk_on_flow| > 2.0', () => {
    assert.equal(flagAggregateFlowStress(0.5, 2.5), true);
  });
  it('fires symmetrically on negative |risk_on_flow| > 2.0', () => {
    assert.equal(flagAggregateFlowStress(0.5, -2.5), true);
  });
  it('does NOT fire when |risk_on| is exactly 2.0 (strict-greater-than)', () => {
    assert.equal(flagAggregateFlowStress(0.5, 2.0), false);
    assert.equal(flagAggregateFlowStress(0.5, -2.0), false);
  });
});

// ── T-EF-17: cold-start → flag false (all aggregate scalars null) ──────────

describe('flagAggregateFlowStress — cold-start (T-EF-17)', () => {
  it('returns false when both aggregate scalars are null', () => {
    assert.equal(flagAggregateFlowStress(null, null), false);
  });
  it('returns false when only dispersion is null and risk_on is in-range', () => {
    assert.equal(flagAggregateFlowStress(null, 1.0), false);
  });
  it('returns false when only risk_on is null and dispersion is in-range', () => {
    assert.equal(flagAggregateFlowStress(1.0, null), false);
  });
});

// ── T-EF-18: Carry-forward: missing day → prior-day value → flow contrib 0 ─

describe('carry-forward semantic (T-EF-18)', () => {
  it('a flat-shares panel produces zero daily flow contributions', () => {
    // Every day i ≥ 1 has shares_i == shares_{i-1}; (Δshares) × close = 0.
    const shares = constArr(FLOW_WINDOW_BD + 1, 1000);
    const closes = Array.from({ length: FLOW_WINDOW_BD + 1 }, (_, i) => 400 + i);
    const flow = computeFlowDollar20bd(shares, closes);
    assertClose(flow, 0);
  });
  it('a single-day pulse contributes exactly (Δshares × close_pulse)', () => {
    // Day 10: shares jump by 50, all other days unchanged.
    const shares = constArr(FLOW_WINDOW_BD + 1, 1000);
    for (let i = 10; i <= FLOW_WINDOW_BD; i++) shares[i] = 1050;
    const closes = constArr(FLOW_WINDOW_BD + 1, 400);
    const flow = computeFlowDollar20bd(shares, closes);
    // Only i=10 contributes: (1050-1000) * 400 = 20000
    assertClose(flow, 20000);
  });
  it('carry-forward days between two updates contribute zero', () => {
    // Day 3: +30 shares at close=100. Day 4-12: carry-forward (no change).
    // Day 13: +20 shares at close=110. Other days unchanged.
    const shares = constArr(FLOW_WINDOW_BD + 1, 1000);
    for (let i = 3; i <= FLOW_WINDOW_BD; i++) shares[i] = 1030;
    for (let i = 13; i <= FLOW_WINDOW_BD; i++) shares[i] = 1050;
    const closes = constArr(FLOW_WINDOW_BD + 1, 100);
    for (let i = 13; i <= FLOW_WINDOW_BD; i++) closes[i] = 110;
    const flow = computeFlowDollar20bd(shares, closes);
    // i=3: (1030-1000)*100 = 3000; i=13: (1050-1030)*110 = 2200; total 5200
    assertClose(flow, 5200);
  });
});

// ── T-EF-19: bd_since_last_share_update increments on stale fixture ────────

describe('bd_since_last_share_update threading (T-EF-19)', () => {
  it('snapshot bdSinceLastShareUpdate = max across the universe', () => {
    const rows: EtfFlowPerEtfInput[] = [
      makePerEtf({ ticker: 'SPY', bdSinceShareUpdate: 1 }),
      makePerEtf({ ticker: 'QQQ', bdSinceShareUpdate: 5 }),
      makePerEtf({ ticker: 'IWM', bdSinceShareUpdate: 2 }),
    ];
    const snap = evaluateEtfFlowComposite(makeInputs({ perEtf: rows }));
    assert.equal(snap.bdSinceLastShareUpdate, 5);
  });
  it('null when no per-ETF rows present', () => {
    const snap = evaluateEtfFlowComposite(makeInputs({ perEtf: [] }));
    assert.equal(snap.bdSinceLastShareUpdate, null);
  });
  it('per-row bdSinceShareUpdate is preserved on the per-ETF row', () => {
    const rows = [makePerEtf({ ticker: 'TLT', bdSinceShareUpdate: 7 })];
    const snap = evaluateEtfFlowComposite(makeInputs({ perEtf: rows }));
    assert.equal(snap.perEtfRows[0].bdSinceShareUpdate, 7);
  });
});

// ── T-EF-20: flagged_etfs deduplicated (divergence OR |z|>2) ───────────────

describe('flagged_etfs construction (T-EF-20)', () => {
  function makePerEtfWithTargetZ(args: {
    ticker: string;
    targetFlowZ: number;
    targetReturnZ: number;
  }): EtfFlowPerEtfInput {
    // Shares grow by a fixed amount over 20bd at constant close. The actual
    // flow_pct_aum is back-computed; then we build the baseline so that the
    // observed flow_pct_aum maps to the target z.
    const sharesT = 1000;
    const sharesTMinus20bd = 950;
    const closeT = 400;
    const closeTMinus20bd = 360;
    const shares = constArr(FLOW_WINDOW_BD + 1, sharesTMinus20bd);
    // Distribute the flow at the last day at close_t — single-pulse fixture.
    for (let i = FLOW_WINDOW_BD; i <= FLOW_WINDOW_BD; i++) shares[i] = sharesT;
    const closes = constArr(FLOW_WINDOW_BD + 1, closeTMinus20bd);
    for (let i = FLOW_WINDOW_BD; i <= FLOW_WINDOW_BD; i++) closes[i] = closeT;

    const flowDollar = (sharesT - sharesTMinus20bd) * closeT;
    const flowPctAum = flowDollar / (sharesT * closeT);
    const ret = closeT / closeTMinus20bd - 1;

    // Build a baseline whose sample stddev is 1, mean = flowPctAum - targetZ.
    // sample stddev with 100 vals: requires sqrt(SS/99) = 1; choose pattern
    // baseline[i] = mean + ((i%2)*2 - 1) * adj where adj solves
    // 100*adj^2 / 99 = 1 → adj = sqrt(99/100). Then mean = flowPctAum - 1*1 = ...
    const flowMean = flowPctAum - args.targetFlowZ; // sample-stddev = 1 by construction
    const retMean = ret - args.targetReturnZ;

    const baseline1yFlowPctAum: number[] = [];
    const baseline1yReturn20bd: number[] = [];
    const adj = Math.sqrt(99 / 100);
    for (let i = 0; i < 100; i++) {
      const sgn = i % 2 === 0 ? +1 : -1;
      baseline1yFlowPctAum.push(flowMean + sgn * adj);
      baseline1yReturn20bd.push(retMean + sgn * adj);
    }

    return {
      ticker: args.ticker,
      shares21: shares,
      closes21: closes,
      baseline1yFlowPctAum,
      baseline1yReturn20bd,
      bdSinceShareUpdate: 0,
    };
  }

  it('flagged list includes divergence ETF and |z|>2 ETF; deduplicates', () => {
    const rows: EtfFlowPerEtfInput[] = [
      // Divergence-only ETF (flow_z=+1.5, return_z=-1.5)
      makePerEtfWithTargetZ({ ticker: 'SPY', targetFlowZ: 1.5, targetReturnZ: -1.5 }),
      // |z|>2 only ETF (flow_z=+2.5, return_z=+2.5 — same sign, no divergence)
      makePerEtfWithTargetZ({ ticker: 'QQQ', targetFlowZ: 2.5, targetReturnZ: 2.5 }),
      // Both divergence AND |z|>2 — should appear once
      makePerEtfWithTargetZ({ ticker: 'IWM', targetFlowZ: 2.5, targetReturnZ: -2.5 }),
      // Not flagged at all (small |z|, same signs)
      makePerEtfWithTargetZ({ ticker: 'DIA', targetFlowZ: 0.5, targetReturnZ: 0.5 }),
    ];
    const snap = evaluateEtfFlowComposite(makeInputs({ perEtf: rows }));

    const flaggedTickers = snap.flaggedEtfs.map((f) => f.ticker);
    assert.ok(flaggedTickers.includes('SPY'), 'divergence-only ETF missing from flagged');
    assert.ok(flaggedTickers.includes('QQQ'), '|z|>2-only ETF missing from flagged');
    assert.ok(flaggedTickers.includes('IWM'), 'both-flags ETF missing from flagged');
    assert.ok(!flaggedTickers.includes('DIA'), 'not-flagged ETF erroneously included');

    // Dedup: IWM appears once even though it satisfies both conditions
    const iwmCount = flaggedTickers.filter((t) => t === 'IWM').length;
    assert.equal(iwmCount, 1, 'IWM should be deduplicated to one entry');
    // Total: 3 unique
    assert.equal(snap.flaggedEtfs.length, 3);

    // divergence_flag carried correctly into the flagged row
    const spy = snap.flaggedEtfs.find((f) => f.ticker === 'SPY')!;
    const qqq = snap.flaggedEtfs.find((f) => f.ticker === 'QQQ')!;
    const iwm = snap.flaggedEtfs.find((f) => f.ticker === 'IWM')!;
    assert.equal(spy.divergenceFlag, true);
    assert.equal(qqq.divergenceFlag, false);
    assert.equal(iwm.divergenceFlag, true);
  });
});

// ── Composite orchestrator integration ──────────────────────────────────────

describe('evaluateEtfFlowComposite (orchestrator)', () => {
  it('empty inputs → cold-start snapshot with version stamp', () => {
    const snap = evaluateEtfFlowComposite(makeInputs());
    assert.equal(snap.version, ETF_FLOW_COMPOSITE_VERSION);
    assert.equal(snap.sectorFlowDispersion, null);
    assert.equal(snap.aggregateRiskOnFlow, null);
    assert.equal(snap.aggregateFlowStressFlag, false);
    assert.deepEqual([...snap.flaggedEtfs], []);
    assert.deepEqual([...snap.perEtfRows], []);
    assert.equal(snap.inputsAvailableAggregateSector, 0);
    assert.equal(snap.inputsAvailableAggregateBroad, 0);
    assert.equal(snap.inputsAvailablePerEtf, 0);
    assert.equal(snap.bdSinceLastShareUpdate, null);
  });

  it('threads lastYfinanceQueryAt + asOf through to the snapshot', () => {
    const queryAt = new Date('2026-05-19T08:00:00Z');
    const inputs = makeInputs({ lastYfinanceQueryAt: queryAt });
    const snap = evaluateEtfFlowComposite(inputs);
    assert.equal(snap.lastYfinanceQueryAt, queryAt);
    assert.equal(snap.snapshotDate, ASOF);
  });

  it('per-ETF row exposes computed shares + dollar + AUM + return scalars', () => {
    // SPY: shares grow 1000 → 1050 in a single pulse at i=10, close stays at 400.
    const shares = constArr(FLOW_WINDOW_BD + 1, 1000);
    for (let i = 10; i <= FLOW_WINDOW_BD; i++) shares[i] = 1050;
    const closes = constArr(FLOW_WINDOW_BD + 1, 400);
    const row = makePerEtf({ ticker: 'SPY', shares21: shares, closes21: closes });
    const snap = evaluateEtfFlowComposite(makeInputs({ perEtf: [row] }));
    const r = snap.perEtfRows[0];
    assert.equal(r.ticker, 'SPY');
    assert.equal(r.group, 'broad');
    assert.equal(r.sharesOutstandingT, 1050);
    assert.equal(r.closeT, 400);
    assertClose(r.aumT, 1050 * 400);
    assert.equal(r.flowShares20bd, 50);
    // Single pulse at i=10, close=400: (1050-1000)*400 = 20000
    assertClose(r.flowDollar20bd, 20000);
    assertClose(r.flowPctAumT!, 20000 / (1050 * 400));
    // Return: close_t / close_{t-20bd} - 1 = 400/400 - 1 = 0
    assertClose(r.return20bd!, 0);
  });

  it('resolves ETF group correctly across all three categories', () => {
    const rows = [
      makePerEtf({ ticker: 'SPY' }),
      makePerEtf({ ticker: 'XLK' }),
      makePerEtf({ ticker: 'TLT' }),
      makePerEtf({ ticker: 'NOT_IN_UNIVERSE' }),
    ];
    const snap = evaluateEtfFlowComposite(makeInputs({ perEtf: rows }));
    const byTicker = new Map(snap.perEtfRows.map((r) => [r.ticker, r.group]));
    assert.equal(byTicker.get('SPY'), 'broad');
    assert.equal(byTicker.get('XLK'), 'sector');
    assert.equal(byTicker.get('TLT'), 'style');
    assert.equal(byTicker.get('NOT_IN_UNIVERSE'), null);
  });

  it('inputsAvailablePerEtf counts only rows with non-null flowPctAumT', () => {
    // One healthy row + one degenerate (sharesT = 0 ⇒ AUM = 0 ⇒ flowPctAum null)
    const healthy = makePerEtf({
      ticker: 'SPY',
      shares21: constArr(FLOW_WINDOW_BD + 1, 1000),
      closes21: constArr(FLOW_WINDOW_BD + 1, 400),
    });
    const degenerate = makePerEtf({
      ticker: 'QQQ',
      shares21: constArr(FLOW_WINDOW_BD + 1, 0),
      closes21: constArr(FLOW_WINDOW_BD + 1, 400),
    });
    const snap = evaluateEtfFlowComposite(makeInputs({ perEtf: [healthy, degenerate] }));
    assert.equal(snap.inputsAvailablePerEtf, 1);
    assert.equal(snap.perEtfRows.length, 2);
  });
});

// ── Constants sanity ────────────────────────────────────────────────────────

describe('constants (sanity)', () => {
  it('exposes the expected SPEC-pinned values', () => {
    assert.equal(ETF_FLOW_COMPOSITE_VERSION, 'etf_flow_v1');
    assert.equal(FLOW_WINDOW_BD, 20);
    assert.equal(MIN_Z_BASELINE, 30);
    assert.equal(DIVERGENCE_Z_THRESHOLD, 1.0);
    assert.equal(SECTOR_FLOW_DISPERSION_THRESHOLD, 2.0);
    assert.equal(AGGREGATE_RISK_ON_FLOW_Z_THRESHOLD, 2.0);
    assert.equal(FLAGGED_ETFS_ABS_Z_THRESHOLD, 2.0);
  });
  it('F-UNIVERSE = 21 ETFs across three groups (matches scripts/etf_flow_ingest.py)', () => {
    assert.equal(BROAD_INDEX_ETFS.length, 6);
    assert.equal(SPDR_SECTOR_ETFS.length, 11);
    assert.equal(STYLE_RISK_ETFS.length, 4);
    assert.equal(ETF_UNIVERSE.length, 21);
    // No overlaps
    const all = new Set<string>(ETF_UNIVERSE);
    assert.equal(all.size, 21);
  });
  it('resolveEtfGroup is correct for representative tickers', () => {
    assert.equal(resolveEtfGroup('SPY'), 'broad');
    assert.equal(resolveEtfGroup('XLE'), 'sector');
    assert.equal(resolveEtfGroup('GLD'), 'style');
    assert.equal(resolveEtfGroup('NOPE'), null);
  });
});
