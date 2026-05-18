/**
 * Pin makeRegimeLookup — the only pure helper in validate_rank1_bear_gate.ts after
 * the refactor to use runCustomBacktest with entryGate. The replay path is now the
 * production engine, so its tests live in backtest_engine.test.ts. The DSR/PSR side
 * is covered by src/lib/psr.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeRegimeLookup } from '../validate_rank1_bear_gate.js';

describe('makeRegimeLookup — non-rewinding cursor', () => {
  // SOL series spanning 7 days of 1-day-spaced points with bull → flat → bear shape.
  const sol = [
    { ts: 0, close: 100 },
    { ts: 86400000, close: 105 },         // +5% over 1d (bullish if window=1d)
    { ts: 86400000 * 2, close: 110 },     // +10% from start
    { ts: 86400000 * 3, close: 109 },     // small dip
    { ts: 86400000 * 4, close: 100 },     // back to start (sideways over 4d)
    { ts: 86400000 * 5, close: 90 },      // -10% from start
    { ts: 86400000 * 6, close: 80 },      // -20% from start
    { ts: 86400000 * 7, close: 75 },      // -25% from start (bearish over 7d)
  ];
  const oneDay = 86400000;

  it('unknown when request is before window-of-history is available', () => {
    const lookup = makeRegimeLookup(sol, 7 * oneDay, 0.05, -0.05);
    // Request at ts=0: no SOL price 7d before that.
    assert.equal(lookup(0), 'unknown');
    // Request at ts=oneDay: still no 7d-prior SOL.
    assert.equal(lookup(oneDay), 'unknown');
  });

  it('classifies bull when log-return > bull threshold over window', () => {
    const lookup = makeRegimeLookup(sol, oneDay, 0.03, -0.03);
    // ts=2d, window=1d: pNow=110, pThen=105, log(110/105) ≈ 0.0465 → above bull 0.03.
    const reg = lookup(oneDay * 2);
    assert.equal(reg, 'bull');
  });

  it('classifies bear when log-return < bear threshold over window', () => {
    const lookup = makeRegimeLookup(sol, oneDay, 0.03, -0.03);
    // ts=6d, window=1d: pNow=80, pThen=90, log(80/90) ≈ -0.118 → below bear -0.03.
    const reg = lookup(oneDay * 6);
    assert.equal(reg, 'bear');
  });

  it('classifies sideways when within thresholds', () => {
    const lookup = makeRegimeLookup(sol, oneDay, 0.05, -0.05);
    // ts=3d, window=1d: pNow=109, pThen=110, log(109/110) ≈ -0.009 → between thresholds.
    assert.equal(lookup(oneDay * 3), 'sideways');
  });

  it('cursors do not rewind — calling in increasing ts order produces correct labels', () => {
    // ts=2d: pNow=110, pThen=105, log≈+0.0465 → bull (above 0.03)
    // ts=3d: pNow=109, pThen=110, log≈-0.0091 → sideways
    // ts=4d: pNow=100, pThen=109, log≈-0.0863 → bear (below -0.03)
    // ts=6d: pNow=80, pThen=90,  log≈-0.1178 → bear
    const lookup = makeRegimeLookup(sol, oneDay, 0.03, -0.03);
    assert.equal(lookup(oneDay * 2), 'bull');
    assert.equal(lookup(oneDay * 3), 'sideways');
    assert.equal(lookup(oneDay * 4), 'bear');
    assert.equal(lookup(oneDay * 6), 'bear');
  });

  it('returns unknown when SOL price is non-positive', () => {
    const badSol = [
      { ts: 0, close: 100 },
      { ts: oneDay, close: 0 },          // zero price — should produce unknown
      { ts: oneDay * 2, close: 110 },
    ];
    const lookup = makeRegimeLookup(badSol, oneDay, 0.05, -0.05);
    // ts=2d looks back to ts=oneDay which has close=0 → unknown.
    assert.equal(lookup(oneDay * 2), 'unknown');
  });
});
