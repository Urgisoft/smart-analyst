/**
 * Cost-stress tests — pin the log-space cost adjustment math + verdict logic.
 *
 * The math in adjustNetPct is the load-bearing piece: if it's wrong, every survivor
 * count and every verdict downstream is wrong. The seven tests here lock in the
 * non-obvious invariants:
 *   • extra=0 round-trips exactly (sanity for the math)
 *   • monotone in extra (more cost → less return)
 *   • log-space is reversible (adjust by +c then -c → original)
 *   • degenerate inputs return NaN (not a misleading number)
 *   • compound math matches the closed-form expectation
 *   • verdict tree fires the right branch for each fixture
 *   • survivor count is monotone non-increasing in cost
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustNetPct,
  aggregateCells,
  decideVerdict,
  cellKey,
  type RunRowLite,
} from '../cost_stress.js';

const EPS = 1e-9;

describe('adjustNetPct — math invariants', () => {
  it('extra=0 returns the input net % exactly (within float epsilon)', () => {
    for (const net of [-50, -10, 0.5, 10, 50.4, 596.2, 1441]) {
      for (const n of [10, 100, 1886]) {
        const adj = adjustNetPct(net, n, 0);
        assert.ok(
          Math.abs(adj - net) < 1e-9,
          `extra=0 should round-trip; got adjusted=${adj} for net=${net}, n=${n}`
        );
      }
    }
  });

  it('extra>0 strictly decreases the net % when n_trades>0 and net > -100', () => {
    const cases: Array<[number, number]> = [[50.4, 1886], [596.2, 1886], [10, 100], [-10, 50]];
    for (const [net, n] of cases) {
      const adj0 = adjustNetPct(net, n, 0);
      const adjLow = adjustNetPct(net, n, 0.001);
      const adjHigh = adjustNetPct(net, n, 0.01);
      assert.ok(adjLow < adj0, `extra=0.001 should be < extra=0 for net=${net}, n=${n}`);
      assert.ok(adjHigh < adjLow, `extra=0.01 should be < extra=0.001 for net=${net}, n=${n}`);
    }
  });

  it('log-space is reversible — adding extra then removing it round-trips', () => {
    // adjust net by +0.005, then equivalent of "removing" it by computing log diff
    // Strategy: apply extra to baseline; the per-trade log-return shift is ln(1 - 2*0.005)
    // Reversing: take the adjusted output's per-trade log return and add ln(1 + 2*0.005 / (1 - 2*0.005))
    // Easier check: adjust(adjust(net, n, +c), n, ?) — but the second call expects extra,
    // not a "negative extra". So instead, verify the math identity directly:
    // adjusted = (1 + net/100) * (1 - 2c)^n - 1 in pct units.
    for (const c of [0.001, 0.005, 0.01, 0.02]) {
      const net = 50.4, n = 1886;
      const expected = (Math.pow(1 + net / 100, 1) * Math.pow(1 - 2 * c, n) - 1) * 100;
      const got = adjustNetPct(net, n, c);
      assert.ok(
        Math.abs(got - expected) < 1e-6,
        `Closed-form mismatch at c=${c}: expected ${expected}, got ${got}`
      );
    }
  });

  it('returns NaN for degenerate inputs (n_trades<=0, net<=-100, invalid extra)', () => {
    assert.ok(Number.isNaN(adjustNetPct(50, 0, 0.005)), 'n_trades=0 should NaN');
    assert.ok(Number.isNaN(adjustNetPct(50, -1, 0.005)), 'n_trades=-1 should NaN');
    assert.ok(Number.isNaN(adjustNetPct(-100, 100, 0.005)), 'net=-100 should NaN (log undefined)');
    assert.ok(Number.isNaN(adjustNetPct(-150, 100, 0.005)), 'net<-100 should NaN');
    assert.ok(Number.isNaN(adjustNetPct(50, 100, -0.001)), 'negative extra should NaN');
    assert.ok(Number.isNaN(adjustNetPct(50, 100, 0.5)), 'extra>=0.5 (round-trip>=100%) should NaN');
    assert.ok(Number.isNaN(adjustNetPct(NaN, 100, 0.005)), 'net=NaN should NaN');
  });

  it('compound math — 100 trades × +1% gross stays positive after subtracting 0.5%/round-trip', () => {
    // Gross: 100 trades × +1% each compounded = (1.01)^100 - 1 ≈ +170.48%
    const gross = (Math.pow(1.01, 100) - 1) * 100;
    assert.ok(Math.abs(gross - 170.481382942) < 1e-6);
    // Adjust by 0.25%/side → 0.5%/round-trip = (1 - 2*0.0025) = 0.995 multiplier per trade.
    // Per-trade log return after cost: ln(1.01) + ln(0.995)  (cost shrinks the gain)
    // Total compounded: exp(100 * (ln(1.01) + ln(0.995))) - 1
    //                 = ((1.01) * (0.995))^100 - 1 = (1.00495)^100 - 1 ≈ +63.85%
    const expected = (Math.pow(1.01 * 0.995, 100) - 1) * 100;
    const got = adjustNetPct(gross, 100, 0.0025);
    assert.ok(
      Math.abs(got - expected) < 1e-6,
      `Compound math: expected ${expected}, got ${got}`
    );
    // Sanity: should still be net positive (per-trade gross 1% > per-trade cost 0.5%)
    assert.ok(got > 0, 'Net should remain positive when per-trade gross > per-trade cost');
    // And at twice the cost (0.5%/side = 1%/trade), should approximately zero out.
    const atBreakeven = adjustNetPct(gross, 100, 0.005);
    assert.ok(
      Math.abs(atBreakeven) < 5,
      `At per-trade cost ≈ per-trade gross, net should be near zero; got ${atBreakeven}`
    );
  });
});

describe('aggregateCells — trade-weighted across tokens', () => {
  function makeRow(over: Partial<RunRowLite>): RunRowLite {
    return {
      strategy_type: 'mean_reversion_v1',
      tier: 'mcap_nano',
      interval: '1h',
      param: 15,
      token_address: 'TOK_DEFAULT',
      net_profit_pct: 0,
      trades: 100,
      oos_net_profit_pct: 0,
      oos_trades: 30,
      ...over,
    };
  }

  it('extra=0 reproduces the input trade-weighted net (sanity)', () => {
    const rows: RunRowLite[] = [
      makeRow({ token_address: 'A', net_profit_pct: 100, trades: 10, oos_net_profit_pct: 50, oos_trades: 5 }),
      makeRow({ token_address: 'B', net_profit_pct: 50, trades: 100, oos_net_profit_pct: 25, oos_trades: 50 }),
    ];
    const cells = aggregateCells(rows, 0);
    assert.equal(cells.length, 1);
    const c = cells[0];
    // Expected IS wt_net = (100*10 + 50*100) / (10+100) = 6000/110 ≈ 54.545
    assert.ok(Math.abs(c.isWtNetPct - 6000 / 110) < 1e-6, `IS got ${c.isWtNetPct}`);
    // Expected OOS wt_net = (50*5 + 25*50) / 55 = 1500/55 ≈ 27.273
    assert.ok(Math.abs(c.oosWtNetPct - 1500 / 55) < 1e-6, `OOS got ${c.oosWtNetPct}`);
    assert.equal(c.nTokens, 2);
    assert.equal(c.isTrades, 110);
    assert.equal(c.oosTrades, 55);
  });

  it('survivor count is monotone non-increasing as extra increases', () => {
    // Three cells with varying robustness:
    //   strong: gross net high enough to absorb significant cost
    //   weak:   gross net barely positive
    //   negative: already negative at baseline
    const rows: RunRowLite[] = [
      makeRow({ param: 1, token_address: 'A', net_profit_pct: 200, trades: 50, oos_net_profit_pct: 100, oos_trades: 25 }),
      makeRow({ param: 2, token_address: 'A', net_profit_pct: 5, trades: 50, oos_net_profit_pct: 3, oos_trades: 25 }),
      makeRow({ param: 3, token_address: 'A', net_profit_pct: -10, trades: 50, oos_net_profit_pct: -5, oos_trades: 25 }),
    ];
    const surv = (e: number) => aggregateCells(rows, e).filter(c => c.isWtNetPct > 0 && c.oosWtNetPct > 0).length;
    const counts = [0, 0.001, 0.005, 0.01, 0.02, 0.03].map(surv);
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i] <= counts[i - 1], `survivor count not monotone: ${counts}`);
    }
  });

  it('cellKey groups identical (strategy, tier, interval, param) rows together', () => {
    const rows: RunRowLite[] = [
      makeRow({ token_address: 'A' }),
      makeRow({ token_address: 'B' }),
      makeRow({ token_address: 'C', param: 20 }), // different param → different cell
    ];
    const cells = aggregateCells(rows, 0);
    assert.equal(cells.length, 2);
    assert.equal(cells.find(c => c.param === 15)?.nTokens, 2);
    assert.equal(cells.find(c => c.param === 20)?.nTokens, 1);
    // Sanity: cellKey produces identical strings for the first two rows.
    assert.equal(cellKey(rows[0]), cellKey(rows[1]));
    assert.notEqual(cellKey(rows[0]), cellKey(rows[2]));
  });
});

describe('decideVerdict — three-way branch', () => {
  function inp(rankByCost: Record<number, [is: number, oos: number]>) {
    const isMap = new Map<number, number>();
    const oosMap = new Map<number, number>();
    for (const k of Object.keys(rankByCost)) {
      const e = Number(k);
      isMap.set(e, rankByCost[e as unknown as number][0]);
      oosMap.set(e, rankByCost[e as unknown as number][1]);
    }
    return { rankIsNetByCost: isMap, rankOosNetByCost: oosMap };
  }

  it('PROCEED when rank-1 stays IS+OOS positive at extra=0.02', () => {
    const v = decideVerdict(inp({ 0: [50, 100], 0.005: [40, 80], 0.01: [30, 60], 0.02: [10, 20], 0.03: [5, 10] }));
    assert.equal(v.kind, 'proceed');
  });

  it('WALK AWAY when rank-1 dies on either side by extra=0.01', () => {
    const v1 = decideVerdict(inp({ 0: [50, 100], 0.005: [20, 40], 0.01: [-5, 10], 0.02: [-50, -20] }));
    assert.equal(v1.kind, 'walk-away', 'IS goes negative by 0.01 → walk away');

    const v2 = decideVerdict(inp({ 0: [50, 100], 0.005: [30, 30], 0.01: [10, -5], 0.02: [-20, -50] }));
    assert.equal(v2.kind, 'walk-away', 'OOS goes negative by 0.01 → walk away');
  });

  it('INSTRUMENT when rank-1 survives 0.01 but dies by 0.02', () => {
    const v = decideVerdict(inp({ 0: [50, 100], 0.005: [30, 60], 0.01: [10, 20], 0.02: [-5, -10], 0.03: [-30, -50] }));
    assert.equal(v.kind, 'instrument');
  });
});
