/**
 * Emits the two reference CSVs the Path 2 validator UI ships as "try it" examples.
 *
 *   docs/fixtures/validator_demo_pass.csv   — synthetic edge, 16 trials × 300 bars.
 *                                             Mirrors validator.test.ts:syntheticEdgeRequest
 *                                             (baseDrift=0.015, driftStep=0.001, noiseSigma=0.01,
 *                                             seed=1234, daily interval). t0 has the strongest
 *                                             drift → ranks #1 → orchestrator should return
 *                                             verdict='pass-all', runnableCount=4.
 *
 *   docs/fixtures/validator_demo_fail.csv   — pure noise, 16 trials × 300 bars.
 *                                             Mirrors pureNoiseRequest (noiseSigma=0.01,
 *                                             seed=5678). The IS-best trial is luck —
 *                                             orchestrator should return verdict ≠ 'pass-all'
 *                                             (DSR or PBO fails).
 *
 *   docs/fixtures/validator_demo_per_asset.csv  — 6 cross-asset Sharpes for the pass fixture
 *                                             (≥4 → enables the bootstrap DSR path).
 *
 * Re-run with `tsx scripts/_emit_validator_demo_csvs.ts` if you change the synthetic params.
 *
 * Output is deterministic: same seeds → byte-identical files.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ───── PRNG / Gaussian — same as scripts/tests/validator.test.ts (mulberry32) ─────
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

interface Row { trialId: string; ts: number; ret: number }

/** Synthetic edge — shared noise sequence across trials so the rank order is deterministic
 *  in drift, not noise. Identical to validator.test.ts:syntheticEdgeRequest. */
function emitEdgeRows(opts: {
  nTrials: number;
  nBars: number;
  baseDrift: number;
  driftStep: number;
  noiseSigma: number;
  seed: number;
}): Row[] {
  const { nTrials, nBars, baseDrift, driftStep, noiseSigma, seed } = opts;
  const rng = mulberry32(seed);
  const noiseSeq = new Array<number>(nBars);
  for (let i = 0; i < nBars; i++) noiseSeq[i] = noiseSigma * gaussian(rng);
  const rows: Row[] = [];
  const baseTs = 1_700_000_000;
  const interval = 86_400;  // daily — matches the test fixture
  for (let t = 0; t < nTrials; t++) {
    const drift = baseDrift - t * driftStep;
    for (let i = 0; i < nBars; i++) {
      rows.push({ trialId: `t${t}`, ts: baseTs + i * interval, ret: drift + noiseSeq[i] });
    }
  }
  return rows;
}

/** Pure noise — independent draws, no drift. Identical to validator.test.ts:pureNoiseRequest. */
function emitNoiseRows(opts: {
  nTrials: number;
  nBars: number;
  noiseSigma: number;
  seed: number;
}): Row[] {
  const { nTrials, nBars, noiseSigma, seed } = opts;
  const rng = mulberry32(seed);
  const rows: Row[] = [];
  const baseTs = 1_700_000_000;
  const interval = 86_400;
  for (let t = 0; t < nTrials; t++) {
    for (let i = 0; i < nBars; i++) {
      rows.push({ trialId: `t${t}`, ts: baseTs + i * interval, ret: noiseSigma * gaussian(rng) });
    }
  }
  return rows;
}

/** Format a Row[] into CSV text matching parseTrialReturnsCsv's expected header. */
function rowsToCsv(rows: Row[]): string {
  const out: string[] = ['trialId,ts,ret'];
  for (const r of rows) {
    // Fixed precision is enough for Sharpe/PBO determinism — the input is decimal returns.
    // 8 decimal places preserves all bits of mulberry32's 32-bit RNG state through the
    // Box-Muller transform within engineering tolerance.
    out.push(`${r.trialId},${r.ts},${r.ret.toFixed(8)}`);
  }
  return out.join('\n') + '\n';
}

function writeOut(relPath: string, content: string): void {
  const abs = resolve(process.cwd(), relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`wrote ${relPath} (${content.length} bytes, ${content.split('\n').length - 1} lines)`);
}

// ───── Pass fixture ─────
const passRows = emitEdgeRows({
  nTrials: 16,
  nBars: 300,
  baseDrift: 0.015,
  driftStep: 0.001,
  noiseSigma: 0.01,
  seed: 1234,
});
writeOut('docs/fixtures/validator_demo_pass.csv', rowsToCsv(passRows));

// ───── Fail fixture ─────
const failRows = emitNoiseRows({
  nTrials: 16,
  nBars: 300,
  noiseSigma: 0.01,
  seed: 5678,
});
writeOut('docs/fixtures/validator_demo_fail.csv', rowsToCsv(failRows));

// ───── Optional per-asset Sharpes for the pass fixture (enables bootstrap DSR path) ─────
// Six tokens with Sharpes clustered around the chosen trial's expected bar-stream Sharpe
// (~1.5 non-annualized for baseDrift=0.015 / sigma=0.01) so the >30% mismatch warning
// does NOT fire — these look like real cross-asset Sharpes for this strategy.
const perAssetCsv = [
  'assetId,sharpe',
  'BTC,1.42',
  'ETH,1.55',
  'SOL,1.38',
  'AVAX,1.61',
  'MATIC,1.47',
  'ARB,1.50',
].join('\n') + '\n';
writeOut('docs/fixtures/validator_demo_per_asset.csv', perAssetCsv);
