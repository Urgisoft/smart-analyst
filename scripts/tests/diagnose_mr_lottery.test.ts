/**
 * Concentration-share helper test — anchors the verdict logic in the lottery
 * diagnostic. The classifier's "top-3 share > 0.6" threshold is meaningless if
 * the helper computing the share has a sign or normalization bug, so we pin
 * the boundaries here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { concentrationShareTopK } from '../diagnose_mr_lottery.js';

describe('concentrationShareTopK', () => {
  it('uniform contributions: top-K share ≈ K / N', () => {
    const xs = new Array(10).fill(1);
    assert.ok(Math.abs(concentrationShareTopK(xs, 1) - 0.1) < 1e-9);
    assert.ok(Math.abs(concentrationShareTopK(xs, 3) - 0.3) < 1e-9);
  });

  it('one jackpot dominates: top-1 share ≈ 1', () => {
    const xs = [1000, 1, 1, 1, 1];
    const s = concentrationShareTopK(xs, 1);
    assert.ok(s > 0.99, `expected top-1 ≈ 1 for jackpot, got ${s}`);
  });

  it('top-3 over a 5-token jackpot pattern crosses 0.6 (lottery threshold)', () => {
    const xs = [100, 80, 60, 5, 5];
    const s = concentrationShareTopK(xs, 3);
    assert.ok(s > 0.6, `lottery shape should clear threshold, got ${s}`);
  });

  it('ignores zero and negative contributions', () => {
    // Negative gross profit can show up if the column was mis-summed; the helper
    // operates on positive contributions only so the share is interpretable.
    const xs = [10, 10, 10, 0, -5];
    assert.ok(Math.abs(concentrationShareTopK(xs, 3) - 1) < 1e-9);
  });

  it('K larger than N caps at total share = 1', () => {
    const xs = [1, 2, 3];
    assert.ok(Math.abs(concentrationShareTopK(xs, 100) - 1) < 1e-9);
  });

  it('K = 0 returns 0', () => {
    assert.equal(concentrationShareTopK([1, 2, 3], 0), 0);
  });

  it('empty / all-non-positive input returns 0', () => {
    assert.equal(concentrationShareTopK([], 3), 0);
    assert.equal(concentrationShareTopK([0, 0, 0], 3), 0);
    assert.equal(concentrationShareTopK([-1, -2, -3], 3), 0);
  });
});
