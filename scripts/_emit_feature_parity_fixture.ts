/**
 * _emit_feature_parity_fixture.ts — emit deterministic candle/SOL series + the
 * expected feature values as computed by the canonical TS reference
 * (`scripts/diagnose_rank1_token_features.ts`).
 *
 * Used by `scripts/tests/test_compute_token_features_weekly.py::test_t3_*`
 * to verify that the Python feature pipeline produces identical output
 * to the TypeScript reference for the 6 existing features.
 *
 * Run:
 *   npx tsx scripts/_emit_feature_parity_fixture.ts
 *
 * Writes:
 *   scripts/tests/fixtures/feature_parity.json
 *
 * Spec: docs/specs/phase-2-behavioral-clustering.md §9.1 T-3, §2.4 PF-6.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTokenFeatures } from './diagnose_rank1_token_features.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const N = 800;
const BASE_TIME_MS = 1740096000000; // 2025-02-21 00:00:00 UTC; arbitrary fixed reference point
const HOUR_MS = 3600 * 1000;

// Deterministic non-trivial close paths. Formulas reproduced VERBATIM in the
// Python test so the inputs match bit-for-bit (no random seeds, no PRNG).
function tokenCandles(): Array<{ time: number; close: number; volume: number }> {
  const out: Array<{ time: number; close: number; volume: number }> = [];
  for (let i = 0; i < N; i++) {
    const time = BASE_TIME_MS + i * HOUR_MS;
    const close = 100 * Math.exp(0.001 * i + 0.05 * Math.sin(i * 0.1));
    const volume = 1.0 + 0.5 * Math.cos(i * 0.05);
    out.push({ time, close, volume });
  }
  return out;
}

function solCandles(): Array<{ ts: number; close: number }> {
  const out: Array<{ ts: number; close: number }> = [];
  for (let i = 0; i < N; i++) {
    const ts = BASE_TIME_MS + i * HOUR_MS;
    const close = 50 * Math.exp(-0.0005 * i + 0.03 * Math.cos(i * 0.07));
    out.push({ ts, close });
  }
  return out;
}

const tok = tokenCandles();
const sol = solCandles();
const features = computeTokenFeatures(tok, sol);

if (!features) {
  console.error('FATAL: TS reference returned null — fixture too short?');
  process.exit(1);
}

const outPath = join(__dirname, 'tests', 'fixtures', 'feature_parity.json');
mkdirSync(dirname(outPath), { recursive: true });

const payload = {
  description:
    'Deterministic fixture for Phase 2 §5.1 T-3 TS-Python feature parity test.',
  generation: {
    generator: 'scripts/_emit_feature_parity_fixture.ts',
    n_candles: N,
    base_time_ms: BASE_TIME_MS,
    hour_ms: HOUR_MS,
    token_close_formula: '100 * exp(0.001*i + 0.05*sin(i*0.1))',
    token_volume_formula: '1.0 + 0.5*cos(i*0.05)',
    sol_close_formula: '50 * exp(-0.0005*i + 0.03*cos(i*0.07))',
    note: 'The Python test reproduces these formulas EXACTLY. Do not change without regenerating the fixture.',
  },
  expected: features,
};

writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`✓ wrote ${outPath}`);
console.log(`  ageDays=${features.ageDays.toFixed(6)}`);
console.log(`  vol30dAnn=${features.vol30dAnn.toFixed(6)}`);
console.log(`  ret7d=${features.ret7d.toFixed(6)}`);
console.log(`  ret30d=${features.ret30d.toFixed(6)}`);
console.log(`  logMedianVolUsd30d=${features.logMedianVolUsd30d.toFixed(6)}`);
console.log(`  betaToSol=${features.betaToSol.toFixed(6)}`);
