/**
 * SPEC §2 — orchestrator behavior. Pins gate routing (parametric vs bootstrap DSR),
 * verdict aggregation, N/A vs fail distinction, threshold overrides, and determinism.
 *
 * Synthetic fixtures use mulberry32 (matches src/lib/psr.ts's bootstrapDSR PRNG) so the
 * tests are seedable and reproducible.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatorScore } from '../../src/lib/validator.js';
import type { ValidatorRequest } from '../../src/lib/validator_request.js';

// ───── Deterministic synthetic-data helpers ─────
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u = rng() || 1e-10;
  const v = rng() || 1e-10;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Synthetic sweep with embedded edge. Trials share one noise sequence so drift ordering
 * is preserved deterministically — trial 0 always ranks #1 by Sharpe regardless of seed.
 * Without shared noise, per-trial drift differences get drowned by per-trial noise paths.
 */
function syntheticEdgeRequest(opts: {
  nTrials: number;
  nBars: number;
  driftStep?: number;
  baseDrift?: number;
  noiseSigma?: number;
  seed?: number;
  splitFrac?: number;
}): ValidatorRequest {
  // baseDrift / driftStep tuned so the chosen trial's Sharpe substantially exceeds the
  // expected-max-of-N noise floor (otherwise DSR rejects even a clear edge — the gate is
  // calibrated to "best-of-N could plausibly be noise" and a narrow inter-trial spread
  // makes the chosen trial indistinguishable from the noise floor).
  const {
    nTrials, nBars,
    driftStep = 0.001,
    baseDrift = 0.015,
    noiseSigma = 0.01,
    seed = 1234,
    splitFrac = 0.5,
  } = opts;
  const rng = mulberry32(seed);
  // Single noise path shared across all trials — keeps Sharpe rank order deterministic
  // w.r.t. drift, which is the property the tests assert on.
  const noiseSeq = new Array<number>(nBars);
  for (let i = 0; i < nBars; i++) noiseSeq[i] = noiseSigma * gaussian(rng);

  const trialReturns: ValidatorRequest['trialReturns'] = [];
  const baseTs = 1_700_000_000;
  const interval = 86_400;
  for (let t = 0; t < nTrials; t++) {
    const drift = baseDrift - t * driftStep;
    for (let i = 0; i < nBars; i++) {
      trialReturns.push({
        trialId: `t${t}`,
        ts: baseTs + i * interval,
        ret: drift + noiseSeq[i],
      });
    }
  }
  return {
    trialReturns,
    chosenTrialId: 't0',
    isOosSplitTs: baseTs + Math.floor(nBars * splitFrac) * interval,
  };
}

/** Pure-noise sweep — no drift. The "best" trial is luck. */
function pureNoiseRequest(opts: {
  nTrials: number;
  nBars: number;
  noiseSigma?: number;
  seed?: number;
}): ValidatorRequest {
  const { nTrials, nBars, noiseSigma = 0.01, seed = 5678 } = opts;
  const rng = mulberry32(seed);
  const trialReturns: ValidatorRequest['trialReturns'] = [];
  const baseTs = 1_700_000_000;
  const interval = 86_400;
  for (let t = 0; t < nTrials; t++) {
    for (let i = 0; i < nBars; i++) {
      trialReturns.push({
        trialId: `t${t}`,
        ts: baseTs + i * interval,
        ret: noiseSigma * gaussian(rng),
      });
    }
  }
  // Pick the trial with the highest IS Sharpe — what an overfit selector would do.
  const ids = [...new Set(trialReturns.map(r => r.trialId))];
  let bestId = ids[0];
  let bestSum = -Infinity;
  for (const id of ids) {
    const sum = trialReturns
      .filter(r => r.trialId === id && r.ts < baseTs + Math.floor(nBars / 2) * interval)
      .reduce((a, r) => a + r.ret, 0);
    if (sum > bestSum) { bestSum = sum; bestId = id; }
  }
  return {
    trialReturns,
    chosenTrialId: bestId,
    isOosSplitTs: baseTs + Math.floor(nBars / 2) * interval,
  };
}

// ───── Happy path: synthetic edge ─────
describe('validatorScore — synthetic edge', () => {
  it('runs all four gates on a 16-trial × 300-bar edge sweep', () => {
    const req = syntheticEdgeRequest({ nTrials: 16, nBars: 300 });
    const r = validatorScore(req);
    // All gates produced a value (PBO needs T>=256 — we have 300).
    assert.equal(r.runnableCount, 4);
    // Chosen trial (t0) has the strongest drift → should rank #1.
    assert.equal(r.context.chosenTrialRank, 1);
    // DSR/HLZ/Pardo should pass on a clear edge; PBO should be < 0.5.
    assert.equal(r.gates.dsr.status, 'pass');
    assert.equal(r.gates.hlz.status, 'pass');
    assert.equal(r.gates.oosIs.status, 'pass');
    assert.equal(r.gates.pbo.status, 'pass');
    assert.equal(r.verdict, 'pass-all');
  });

  it('chosenTrialRank reflects Sharpe ordering', () => {
    const req = syntheticEdgeRequest({ nTrials: 5, nBars: 100 });
    // Pick the weakest-drift trial — should rank ~5.
    req.chosenTrialId = 't4';
    const r = validatorScore(req);
    assert.ok(r.context.chosenTrialRank >= 3,
      `weakest-drift trial should rank >= 3, got ${r.context.chosenTrialRank}`);
  });
});

// ───── Pure noise / negative control ─────
describe('validatorScore — pure noise', () => {
  it('flags pure-noise IS-best as not pass-all', () => {
    const req = pureNoiseRequest({ nTrials: 16, nBars: 300 });
    const r = validatorScore(req);
    // Should fail at least DSR or PBO (the selection-bias-aware gates).
    const hardFails = r.gates.dsr.status === 'fail' || r.gates.pbo.status === 'fail';
    assert.ok(hardFails, `expected DSR or PBO to fail on noise; got DSR=${r.gates.dsr.status}, PBO=${r.gates.pbo.status}`);
    assert.notEqual(r.verdict, 'pass-all');
  });
});

// ───── DSR routing ─────
describe('validatorScore — DSR path selection', () => {
  it('uses parametric DSR when perAssetSharpes is omitted', () => {
    const req = syntheticEdgeRequest({ nTrials: 8, nBars: 120 });
    const r = validatorScore(req);
    assert.equal((r.gates.dsr.extras as { method: string }).method, 'parametric');
  });

  it('uses bootstrap DSR when perAssetSharpes has >= 4 entries', () => {
    const req = syntheticEdgeRequest({ nTrials: 8, nBars: 120 });
    req.perAssetSharpes = [
      { assetId: 'A', sharpe: 1.0 },
      { assetId: 'B', sharpe: 1.1 },
      { assetId: 'C', sharpe: 0.9 },
      { assetId: 'D', sharpe: 1.2 },
    ];
    const r = validatorScore(req);
    assert.equal((r.gates.dsr.extras as { method: string }).method, 'bootstrap');
  });

  it('falls back to parametric when perAssetSharpes < 4', () => {
    const req = syntheticEdgeRequest({ nTrials: 8, nBars: 120 });
    req.perAssetSharpes = [
      { assetId: 'A', sharpe: 1.0 },
      { assetId: 'B', sharpe: 1.1 },
    ];
    const r = validatorScore(req);
    assert.equal((r.gates.dsr.extras as { method: string }).method, 'parametric');
  });
});

// ───── PBO N/A vs runnable ─────
describe('validatorScore — PBO availability', () => {
  it('reports PBO N/A when T < 256 (CSCV infeasible)', () => {
    const req = syntheticEdgeRequest({ nTrials: 4, nBars: 100 });
    const r = validatorScore(req);
    assert.equal(r.gates.pbo.status, 'na');
    assert.ok(r.gates.pbo.missingInput, 'missingInput should be set on N/A');
    // Other gates still run.
    assert.notEqual(r.gates.dsr.status, 'na');
    assert.notEqual(r.gates.hlz.status, 'na');
    assert.notEqual(r.gates.oosIs.status, 'na');
    assert.equal(r.runnableCount, 3);
  });

  it('runs PBO when T >= 256', () => {
    const req = syntheticEdgeRequest({ nTrials: 4, nBars: 300 });
    const r = validatorScore(req);
    assert.notEqual(r.gates.pbo.status, 'na');
    assert.equal(r.runnableCount, 4);
  });
});

// ───── Verdict aggregation ─────
describe('validatorScore — verdict bucketing', () => {
  it('verdict pass-all when all gates pass', () => {
    const req = syntheticEdgeRequest({ nTrials: 16, nBars: 300 });
    const r = validatorScore(req);
    assert.equal(r.verdict, 'pass-all');
    assert.equal(r.passCount, 4);
  });

  it('verdict fail-all forces fail when threshold overrides drive every gate to fail', () => {
    const req = syntheticEdgeRequest({ nTrials: 16, nBars: 300 });
    // Set thresholds so high that even a clear edge fails everything.
    req.thresholds = { dsrGate: 1.01, pboGate: 0.0, pardoGate: 100.0, hlzAlpha: 1e-300 };
    const r = validatorScore(req);
    assert.equal(r.verdict, 'fail-all');
    assert.equal(r.passCount, 0);
  });

  it('headlineSentence format matches "{pass} of {runnable} gates pass."', () => {
    const req = syntheticEdgeRequest({ nTrials: 16, nBars: 300 });
    const r = validatorScore(req);
    assert.equal(r.headlineSentence, `${r.passCount} of ${r.runnableCount} gates pass.`);
  });
});

// ───── Threshold overrides ─────
describe('validatorScore — threshold overrides', () => {
  it('raising dsrGate flips DSR pass → fail without changing other gates', () => {
    const req = syntheticEdgeRequest({ nTrials: 16, nBars: 300 });
    const baseline = validatorScore(req);
    assert.equal(baseline.gates.dsr.status, 'pass');

    const tightened = validatorScore({ ...req, thresholds: { dsrGate: 1.01 } });
    assert.equal(tightened.gates.dsr.status, 'fail');
    // Other gates unchanged.
    assert.equal(tightened.gates.pbo.status, baseline.gates.pbo.status);
    assert.equal(tightened.gates.hlz.status, baseline.gates.hlz.status);
    assert.equal(tightened.gates.oosIs.status, baseline.gates.oosIs.status);
  });
});

// ───── Determinism ─────
describe('validatorScore — determinism', () => {
  it('same input produces identical output across two calls', () => {
    const req = syntheticEdgeRequest({ nTrials: 16, nBars: 300 });
    req.perAssetSharpes = [
      { assetId: 'A', sharpe: 1.0 },
      { assetId: 'B', sharpe: 1.1 },
      { assetId: 'C', sharpe: 0.9 },
      { assetId: 'D', sharpe: 1.2 },
    ];
    const r1 = validatorScore(req);
    const r2 = validatorScore(req);
    assert.deepEqual(r1.gates.dsr.value, r2.gates.dsr.value);
    assert.deepEqual(r1.gates.pbo.value, r2.gates.pbo.value);
    assert.deepEqual(r1.gates.hlz.value, r2.gates.hlz.value);
    assert.deepEqual(r1.gates.oosIs.value, r2.gates.oosIs.value);
  });
});

// ───── Sanity-warning emission ─────
describe('validatorScore — perAssetSharpes mismatch warning', () => {
  it('emits a warning when perAssetSharpes median diverges > 30% from bar-stream Sharpe', () => {
    const req = syntheticEdgeRequest({ nTrials: 8, nBars: 120 });
    // Wildly inflated per-asset Sharpes vs the actual bar-stream Sharpe.
    req.perAssetSharpes = [
      { assetId: 'A', sharpe: 10.0 },
      { assetId: 'B', sharpe: 11.0 },
      { assetId: 'C', sharpe: 10.5 },
      { assetId: 'D', sharpe: 9.5 },
    ];
    const r = validatorScore(req);
    assert.ok(
      r.warnings.some(w => w.includes('differs from bar-return Sharpe')),
      `expected mismatch warning; got: ${JSON.stringify(r.warnings)}`,
    );
  });
});
