/**
 * Tests for src/server/equity_xs.ts + scripts/phase_b_campaign_equity_xs_v1.ts
 * — the cross-sectional equity-alpha harness (P0 + P1).
 *
 * Coverage:
 *   - rankNormalize: monotone [0,1], ties average, edge cases
 *   - computeSInst: contrarian short-interest, missing-SI neutral imputation,
 *     equal-weight rank-of-ranks composite
 *   - applyLiquidityGate: drops below-floor names, keeps the rest
 *   - assignQuintileLegs: Q5 long / Q1 short, equal weight, empty when N<5
 *   - tickerDailyReturns: window slicing, prior-close requirement
 *   - buildPortfolios: t-1 lag (no look-ahead), dollar-neutral LS both-leg rule
 *   - betaNeutralize: pure-beta stream → ≈0 residual mean (the alpha test)
 *   - variantToVerdictRow: survivorship-suspect forces phase_c off; anti-shopping
 *   - Constants pinned: COMPOSITE_VERSION, free-param budget
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSITE_VERSION,
  INSIDER_WINDOW_DAYS,
  LIQUIDITY_FLOOR_PCT,
  N_QUANTILES,
  IS_END_DATE,
  OOS_START_DATE,
  rankNormalize,
  computeSInst,
  applyLiquidityGate,
  assignQuintileLegs,
  tickerDailyReturns,
  buildPortfolios,
  betaNeutralize,
  type TickerFeatureRow,
  type RebalanceSnapshot,
  type PriceSeries,
} from '../../src/server/equity_xs.js';
import {
  variantToVerdictRow,
  runGatesForVariant,
  type VariantGateResult,
} from '../phase_b_campaign_equity_xs_v1.js';

// ── Constants / anti-shopping pins ────────────────────────────────────────────

describe('equity_xs constants', () => {
  it('composite version pinned to equity_xs_v1 (anti-shopping)', () => {
    assert.equal(COMPOSITE_VERSION, 'equity_xs_v1');
  });
  it('free-parameter budget: insider window 90d, liquidity floor, quintiles=5', () => {
    assert.equal(INSIDER_WINDOW_DAYS, 90);
    assert.ok(LIQUIDITY_FLOOR_PCT > 0 && LIQUIDITY_FLOOR_PCT < 1);
    assert.equal(N_QUANTILES, 5);
  });
  it('fixed 70/30 walk-forward split per spec §3.5', () => {
    assert.equal(IS_END_DATE, '2020-12-31');
    assert.equal(OOS_START_DATE, '2021-01-01');
  });
});

// ── rankNormalize ─────────────────────────────────────────────────────────────

describe('rankNormalize', () => {
  it('maps sorted distinct values to evenly-spaced [0,1]', () => {
    const r = rankNormalize([10, 20, 30, 40, 50]);
    assert.deepEqual(r, [0, 0.25, 0.5, 0.75, 1]);
  });
  it('is order-invariant (assigns by value, not position)', () => {
    const r = rankNormalize([50, 10, 30]);
    assert.deepEqual(r, [1, 0, 0.5]);
  });
  it('averages tied ranks', () => {
    const r = rankNormalize([5, 5, 5, 5]);
    assert.deepEqual(r, [0.5, 0.5, 0.5, 0.5]);
  });
  it('partial ties average correctly', () => {
    // values 1,2,2,3 → positions 0, (1+2)/2=1.5, 1.5, 3 → /3 = 0, .5, .5, 1
    const r = rankNormalize([1, 2, 2, 3]);
    assert.deepEqual(r, [0, 0.5, 0.5, 1]);
  });
  it('empty → [], singleton → [0.5]', () => {
    assert.deepEqual(rankNormalize([]), []);
    assert.deepEqual(rankNormalize([7]), [0.5]);
  });
});

// ── computeSInst ──────────────────────────────────────────────────────────────

function row(t: string, net: number, act: number, si: number | null, adv = 1e9): TickerFeatureRow {
  return { ticker: t, netInsiderBuyUsd: net, activistFlag: act, shortInterestChangePct: si, advDollar: adv };
}

describe('computeSInst', () => {
  it('higher net insider buying ranks higher (all else equal)', () => {
    const rows = [row('A', 100, 0, 0), row('B', 200, 0, 0), row('C', 50, 0, 0)];
    const s = computeSInst(rows);
    // B (highest net) should have the top final rank.
    assert.ok(s[1] >= s[0] && s[1] >= s[2]);
  });
  it('short-interest is CONTRARIAN: falling SI (negative change) ranks higher', () => {
    // Hold insider+activist constant; only SI differs.
    const rows = [row('A', 0, 0, +50), row('B', 0, 0, -50), row('C', 0, 0, 0)];
    const s = computeSInst(rows);
    // B has the most-falling SI → most bullish → highest final rank.
    assert.ok(s[1] >= s[0] && s[1] >= s[2]);
    assert.ok(s[1] > s[0]); // strictly above the rising-SI name
  });
  it('missing short-interest is imputed neutral (0.5), not dropped', () => {
    const rows = [row('A', 0, 0, null), row('B', 0, 0, null), row('C', 0, 0, null)];
    const s = computeSInst(rows);
    // All neutral on every component → all final ranks equal (0.5 after re-rank).
    assert.deepEqual(s, [0.5, 0.5, 0.5]);
  });
  it('activist flag contributes positively', () => {
    const rows = [row('A', 0, 1, 0), row('B', 0, 0, 0), row('C', 0, 0, 0)];
    const s = computeSInst(rows);
    assert.ok(s[0] >= s[1] && s[0] >= s[2]);
  });
  it('empty universe → []', () => {
    assert.deepEqual(computeSInst([]), []);
  });
});

// ── applyLiquidityGate ────────────────────────────────────────────────────────

describe('applyLiquidityGate', () => {
  it('drops names below the floor percentile', () => {
    const rows = [
      row('A', 0, 0, 0, 1e6),   // lowest ADV
      row('B', 0, 0, 0, 1e7),
      row('C', 0, 0, 0, 1e8),
      row('D', 0, 0, 0, 1e9),
      row('E', 0, 0, 0, 1e10),  // highest ADV
    ];
    // floor 0.10 → ranks are [0,.25,.5,.75,1]; >= 0.10 keeps all but the 0-rank A.
    const kept = applyLiquidityGate(rows, 0.10);
    assert.deepEqual(kept.map(r => r.ticker), ['B', 'C', 'D', 'E']);
  });
  it('floor 0 keeps everyone', () => {
    const rows = [row('A', 0, 0, 0, 1), row('B', 0, 0, 0, 2)];
    assert.equal(applyLiquidityGate(rows, 0).length, 2);
  });
  it('empty → []', () => {
    assert.deepEqual(applyLiquidityGate([]), []);
  });
});

// ── assignQuintileLegs ────────────────────────────────────────────────────────

describe('assignQuintileLegs', () => {
  it('top quintile long, bottom quintile short, equal weight', () => {
    const tickers = ['A', 'B', 'C', 'D', 'E'];
    const scores = [0.1, 0.3, 0.5, 0.7, 0.9];
    const { long, short } = assignQuintileLegs(tickers, scores);
    // rank cuts: hi=0.8, lo=0.2 → E (rank1) long, A (rank0) short.
    assert.deepEqual([...long.keys()], ['E']);
    assert.deepEqual([...short.keys()], ['A']);
    assert.equal(long.get('E'), 1);
    assert.equal(short.get('A'), 1);
  });
  it('empty legs when fewer than N_QUANTILES names', () => {
    const { long, short } = assignQuintileLegs(['A', 'B'], [0.1, 0.9]);
    assert.equal(long.size, 0);
    assert.equal(short.size, 0);
  });
  it('weights within a leg sum to 1', () => {
    const tickers = Array.from({ length: 10 }, (_, i) => `T${i}`);
    const scores = tickers.map((_, i) => i / 9);
    const { long, short } = assignQuintileLegs(tickers, scores);
    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum(long) - 1) < 1e-9);
    assert.ok(Math.abs(sum(short) - 1) < 1e-9);
  });
});

// ── tickerDailyReturns ────────────────────────────────────────────────────────

describe('tickerDailyReturns', () => {
  const series = {
    dates: ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-04'],
    closes: [100, 110, 121, 121],
  };
  it('computes close-to-close returns within [start,end)', () => {
    const { dates, returns } = tickerDailyReturns(series, '2020-01-02', '2020-01-04');
    // step into 01-02 (110/100-1=.1) and 01-03 (121/110-1=.1); 01-04 excluded.
    assert.deepEqual(dates, ['2020-01-02', '2020-01-03']);
    assert.ok(Math.abs(returns[0] - 0.1) < 1e-9);
    assert.ok(Math.abs(returns[1] - 0.1) < 1e-9);
  });
  it('undefined series → empty', () => {
    assert.deepEqual(tickerDailyReturns(undefined, '2020-01-01', '2020-12-31'), { dates: [], returns: [] });
  });
});

// ── buildPortfolios: t-1 lag + dollar-neutral both-leg rule ───────────────────

describe('buildPortfolios', () => {
  // 3 rebalances; 6 tickers so quintiles (N=5+) form legs.
  const dates = ['2020-01-01', '2020-02-01', '2020-03-01'];
  function mkSnap(date: string, ordering: string[]): RebalanceSnapshot {
    // Give monotonically increasing insider-buy so leg assignment is deterministic.
    const rows: TickerFeatureRow[] = ordering.map((t, i) =>
      row(t, i * 100, 0, null, 1e9),
    );
    return { date, rows };
  }
  const snapshots: RebalanceSnapshot[] = [
    mkSnap('2020-01-01', ['A', 'B', 'C', 'D', 'E', 'F']), // F top, A bottom
    mkSnap('2020-02-01', ['A', 'B', 'C', 'D', 'E', 'F']),
    mkSnap('2020-03-01', ['A', 'B', 'C', 'D', 'E', 'F']),
  ];
  // Prices: F rises, A falls during the Feb holding period.
  const byTicker = new Map<string, { dates: string[]; closes: number[] }>();
  for (const t of ['A', 'B', 'C', 'D', 'E', 'F']) {
    byTicker.set(`${t}_SP500`, {
      dates: ['2020-01-31', '2020-02-03', '2020-02-04', '2020-02-28'],
      closes: t === 'F' ? [100, 110, 121, 130] : t === 'A' ? [100, 90, 81, 80] : [100, 100, 100, 100],
    });
  }
  const prices: PriceSeries = { byTicker };

  it('long-short uses t-1 lagged scores and is dollar-neutral (long − short)', () => {
    const built = buildPortfolios({ snapshots, prices, priceSuffix: '_SP500' });
    // Holding period k=1 spans [Feb, Mar); legs from snapshot[0] (t-1 lag).
    // 6 monotone names → rank cuts hi=0.8/lo=0.2: long leg = {E,F} (rank .8,1),
    // short leg = {A,B} (rank 0,.2). E and B are flat (close=const → r=0).
    // On 2020-02-03: long = mean(r_F=.1, r_E=0)=.05; short = mean(r_A=-.1, r_B=0)=-.05.
    // LS = long − short = .05 − (−.05) = .10.
    const idx = built.longShort.dates.indexOf('2020-02-03');
    assert.ok(idx >= 0);
    assert.ok(Math.abs(built.longShort.returns[idx] - 0.10) < 1e-9);
  });
  it('reports both-leg rebalance count', () => {
    const built = buildPortfolios({ snapshots, prices, priceSuffix: '_SP500' });
    assert.ok(built.meta.nRebalancesWithBothLegs >= 1);
  });
});

// ── betaNeutralize: the alpha test ────────────────────────────────────────────

describe('betaNeutralize', () => {
  it('a pure-beta stream (r_p = 2·r_SPY) has ≈0 residual', () => {
    const spy = { dates: ['d1', 'd2', 'd3', 'd4'], returns: [0.01, -0.02, 0.03, -0.01] };
    const port = { dates: spy.dates, returns: spy.returns.map(r => 2 * r) };
    const { residual, beta } = betaNeutralize(port, spy);
    assert.ok(Math.abs(beta - 2) < 1e-6);
    // Residual = y - β·x ≈ 0 for every date.
    for (const r of residual.returns) assert.ok(Math.abs(r) < 1e-9);
  });
  it('a stream with constant alpha keeps the alpha in the residual', () => {
    const spy = { dates: ['d1', 'd2', 'd3', 'd4'], returns: [0.01, -0.02, 0.03, -0.01] };
    const port = { dates: spy.dates, returns: spy.returns.map(r => 1 * r + 0.005) };
    const { residual, beta, alphaDaily } = betaNeutralize(port, spy);
    assert.ok(Math.abs(beta - 1) < 1e-6);
    assert.ok(Math.abs(alphaDaily - 0.005) < 1e-6);
    // residual mean ≈ alpha
    const mean = residual.returns.reduce((a, b) => a + b, 0) / residual.returns.length;
    assert.ok(Math.abs(mean - 0.005) < 1e-6);
  });
  it('n<2 shared dates → passthrough, beta 0', () => {
    const r = betaNeutralize({ dates: ['x'], returns: [0.01] }, { dates: ['y'], returns: [0.02] });
    assert.equal(r.beta, 0);
    assert.equal(r.n, 0);
  });
});

// ── variantToVerdictRow: survivorship gate + anti-shopping ────────────────────

function passAllVariant(): VariantGateResult {
  const pass = (v: number): VariantGateResult['dsr'] =>
    ({ status: 'pass', value: v, threshold: 0, label: '', source: '', intuition: '', explanation: '', failureMode: '' });
  return {
    variant: 'Q5-Q1_long_short',
    isSharpe: 0.1, oosSharpe: 0.08,
    dsr: pass(0.99), pbo: pass(0.1), hlz: pass(3), oosIs: pass(0.8),
    verdict: 'pass-all',
  };
}

describe('variantToVerdictRow', () => {
  it('survivorship-suspect forces phase_c_eligible OFF even on pass-all', () => {
    const row = variantToVerdictRow(passAllVariant(), /*suspect*/ true, 'note;');
    assert.equal(row.verdict, 'pass-all');
    assert.equal(row.phaseCEligible, false);
  });
  it('not-suspect pass-all with PBO<0.2 → phase_c eligible', () => {
    const row = variantToVerdictRow(passAllVariant(), false, 'note;');
    assert.equal(row.phaseCEligible, true);
  });
  it('composite_version pinned + variant carried in benchmark field', () => {
    const row = variantToVerdictRow(passAllVariant(), false, 'note;');
    assert.equal(row.compositeVersion, 'equity_xs_v1');
    assert.equal(row.benchmark, 'Q5-Q1_long_short');
  });
});

// ── runGatesForVariant: insufficient when CSCV can't run ──────────────────────

describe('runGatesForVariant', () => {
  it('short return streams → PBO na → verdict insufficient (honest, not a pass)', () => {
    const isR = [0.01, -0.01, 0.02, -0.02]; // 4 bars « 256 CSCV floor
    const oosR = [0.01, 0.0];
    const res = runGatesForVariant('Q5-Q1_long_short', isR, oosR, [0.05, 0.02], 1, 2, [isR, [0.0, 0.0, 0.0, 0.0]]);
    assert.equal(res.pbo.status, 'na');
    assert.equal(res.verdict, 'insufficient');
  });
});
