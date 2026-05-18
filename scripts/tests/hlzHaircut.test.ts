/**
 * HLZ haircut tests — verify each procedure's critical t-stat formula against known
 * limits, monotonicity, and ordering.
 *
 * Doesn't try to match HLZ Table 6 numerically (Table 6 reports population-level haircuts
 * under their model, which is a different quantity from BHY-procedure thresholds).
 * Instead pins the mathematical relationships that must hold for the formulas to be
 * implemented correctly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hlzHaircut, applyLeaderboardHaircut } from '../../src/lib/hlzHaircut.js';

describe('hlzHaircut', () => {
  it('T11: M=1, two-sided α=0.05 reduces to single-test 1.96 threshold (all methods)', () => {
    for (const method of ['bonferroni', 'holm', 'bhy'] as const) {
      const r = hlzHaircut({ observedT: 0, rank: 1, nTests: 1, method, alpha: 0.05, twoSided: true });
      assert.ok(Math.abs(r.threshold - 1.96) < 0.01,
        `${method} M=1 two-sided ≈ 1.96, got ${r.threshold}`);
    }
  });

  it('M=1 one-sided α=0.05 reduces to 1.645 (all methods)', () => {
    for (const method of ['bonferroni', 'holm', 'bhy'] as const) {
      const r = hlzHaircut({ observedT: 0, rank: 1, nTests: 1, method, alpha: 0.05, twoSided: false });
      assert.ok(Math.abs(r.threshold - 1.645) < 0.01,
        `${method} M=1 one-sided ≈ 1.645, got ${r.threshold}`);
    }
  });

  it('T12: M=51 BHY rank=1 threshold is materially stricter than M=1 (multiple-testing penalty)', () => {
    const single = hlzHaircut({ observedT: 0, rank: 1, nTests: 1, method: 'bhy', alpha: 0.05, twoSided: true });
    const fifty = hlzHaircut({ observedT: 0, rank: 1, nTests: 51, method: 'bhy', alpha: 0.05, twoSided: true });
    assert.ok(fifty.threshold > single.threshold + 1.0,
      `M=51 BHY rank=1 should add ≥ 1.0 t-stat penalty over M=1; got ${fifty.threshold} vs ${single.threshold}`);
    // Sanity: BHY at M=51 rank=1 with c(51) ≈ 4.518 lands around t ≈ 3.7 two-sided.
    assert.ok(fifty.threshold > 3.4 && fifty.threshold < 4.0,
      `M=51 BHY rank=1 two-sided expected in [3.4, 4.0], got ${fifty.threshold}`);
  });

  it('T13: BHY threshold is rank-dependent — strictest at k=1, loosest at k=M', () => {
    const M = 51;
    const k1 = hlzHaircut({ observedT: 0, rank: 1, nTests: M, method: 'bhy' });
    const kMid = hlzHaircut({ observedT: 0, rank: 25, nTests: M, method: 'bhy' });
    const kM = hlzHaircut({ observedT: 0, rank: M, nTests: M, method: 'bhy' });
    assert.ok(k1.threshold > kMid.threshold && kMid.threshold > kM.threshold,
      `BHY: t(k=1) > t(k=mid) > t(k=M); got ${k1.threshold}, ${kMid.threshold}, ${kM.threshold}`);
  });

  it('Holm step-down: strictest at k=1, equals single-test at k=M', () => {
    const M = 20;
    const k1 = hlzHaircut({ observedT: 0, rank: 1, nTests: M, method: 'holm' });
    const kM = hlzHaircut({ observedT: 0, rank: M, nTests: M, method: 'holm' });
    // At k=1, Holm matches Bonferroni (α/M); at k=M, Holm reduces to single-test (α/1).
    const bonferroni = hlzHaircut({ observedT: 0, rank: 1, nTests: M, method: 'bonferroni' });
    const single = hlzHaircut({ observedT: 0, rank: 1, nTests: 1, method: 'holm' });
    assert.ok(Math.abs(k1.threshold - bonferroni.threshold) < 1e-9,
      `Holm k=1 should equal Bonferroni; got ${k1.threshold} vs ${bonferroni.threshold}`);
    assert.ok(Math.abs(kM.threshold - single.threshold) < 1e-9,
      `Holm k=M should equal single-test; got ${kM.threshold} vs ${single.threshold}`);
  });

  it('Bonferroni is rank-independent', () => {
    const M = 20;
    const k1 = hlzHaircut({ observedT: 0, rank: 1, nTests: M, method: 'bonferroni' });
    const kM = hlzHaircut({ observedT: 0, rank: M, nTests: M, method: 'bonferroni' });
    assert.equal(k1.threshold, kM.threshold);
  });

  it('At rank=1, BF == Holm < BHY in stringency (BHY most strict at the top)', () => {
    // BF: α/M.  Holm at k=1: α/(M − 0) = α/M.  BHY at k=1: α/(M · H_M), and H_M > 1 for
    // M > 1, so BHY's p-threshold is smaller → its t-threshold is larger → BHY most strict
    // at the most-significant rank. (BHY's flexibility shows up at lower ranks.)
    const M = 100;
    const bf = hlzHaircut({ observedT: 0, rank: 1, nTests: M, method: 'bonferroni' });
    const holm = hlzHaircut({ observedT: 0, rank: 1, nTests: M, method: 'holm' });
    const bhy = hlzHaircut({ observedT: 0, rank: 1, nTests: M, method: 'bhy' });
    assert.ok(Math.abs(bf.threshold - holm.threshold) < 1e-9, 'BF and Holm equal at k=1');
    assert.ok(bhy.threshold > bf.threshold,
      `BHY at k=1 should be most strict; got bhy=${bhy.threshold}, bf=${bf.threshold}`);
  });

  it('passes flag toggles correctly at the threshold', () => {
    const r1 = hlzHaircut({ observedT: 1.95, rank: 1, nTests: 1, method: 'bhy', alpha: 0.05, twoSided: true });
    const r2 = hlzHaircut({ observedT: 1.97, rank: 1, nTests: 1, method: 'bhy', alpha: 0.05, twoSided: true });
    assert.equal(r1.passes, false);
    assert.equal(r2.passes, true);
  });

  it('invalid rank/M returns passes=false with infinite threshold', () => {
    const r1 = hlzHaircut({ observedT: 100, rank: 0, nTests: 10 });
    const r2 = hlzHaircut({ observedT: 100, rank: 11, nTests: 10 });
    const r3 = hlzHaircut({ observedT: 100, rank: 1, nTests: 0 });
    for (const r of [r1, r2, r3]) {
      assert.equal(r.passes, false);
      assert.equal(r.threshold, Infinity);
    }
  });
});

describe('applyLeaderboardHaircut', () => {
  it('sorts by t-stat descending and assigns ranks 1..M', () => {
    const cells = [
      { id: 'a', observedT: 1.5 },
      { id: 'b', observedT: 4.2 },
      { id: 'c', observedT: 2.8 },
    ];
    const result = applyLeaderboardHaircut({ cells, method: 'bhy' });
    assert.equal(result[0].id, 'b');
    assert.equal(result[0].rank, 1);
    assert.equal(result[1].id, 'c');
    assert.equal(result[1].rank, 2);
    assert.equal(result[2].id, 'a');
    assert.equal(result[2].rank, 3);
  });

  it('with M=51 cells and BHY, only the dominant t-stats pass', () => {
    // 51 cells: one strong (t=5.0), one moderate (t=3.0), 49 weak (t=1.5).
    const cells = [
      { id: 'strong', observedT: 5.0 },
      { id: 'moderate', observedT: 3.0 },
    ];
    for (let i = 0; i < 49; i++) cells.push({ id: `weak${i}`, observedT: 1.5 });
    const result = applyLeaderboardHaircut({ cells, method: 'bhy', alpha: 0.05, twoSided: true });
    const strong = result.find(r => r.id === 'strong')!;
    const moderate = result.find(r => r.id === 'moderate')!;
    assert.equal(strong.passes, true, 't=5.0 should pass at M=51 BHY rank=1');
    // Moderate t=3.0 won't clear k=2 BHY threshold at M=51; sanity check.
    assert.equal(moderate.passes, false, 't=3.0 at rank=2 should not clear BHY at M=51');
    // None of the weak cells pass.
    for (const w of result.filter(r => r.id.startsWith('weak'))) {
      assert.equal(w.passes, false);
    }
  });

  it('ties in t-stat use stable original-order tiebreaker', () => {
    const cells = [
      { id: 'a', observedT: 2.0 },
      { id: 'b', observedT: 2.0 },
      { id: 'c', observedT: 3.0 },
    ];
    const result = applyLeaderboardHaircut({ cells });
    assert.equal(result[0].id, 'c');
    // Tie: original order preserved.
    assert.equal(result[1].id, 'a');
    assert.equal(result[2].id, 'b');
  });
});
