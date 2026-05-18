/**
 * One-off smoke verifier: load each fixture under
 * scripts/tests/fixtures/cell_weights/ and run computeCellWeights /
 * selectCellWeightsTier against it, comparing to the Python-reference
 * `expected` block.
 *
 * Two fixture shapes are handled:
 *   - HRP weights fixtures (id starts with `hrp_*`) — exercise
 *     `computeCellWeights`, compare weights at 1e-9.
 *   - Tier-selection parity fixture (id === `tier_selection_parity`,
 *     session 72) — exercise `selectCellWeightsTier`, compare exact tier
 *     on every scenario.
 *
 * NOT a unit test. Just a fast guardrail to catch TS↔Python divergence
 * during development. `_`-prefixed per session-65 conventions; no help-entry.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeCellWeights,
  selectCellWeightsTier,
  type CellWeightsTier,
  type CellWeightsTierInput,
} from '../src/server/cell_weights.js';

const dir = join(process.cwd(), 'scripts/tests/fixtures/cell_weights');
const files = readdirSync(dir).filter(f => f.endsWith('.json'));

let failed = 0;
let hrpCount = 0;
let tierParityChecked = false;

for (const f of files) {
  const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Record<string, unknown>;
  const id = String(raw.id ?? '');

  // --- Tier-selection parity fixture (session 72) ---
  if (id === 'tier_selection_parity') {
    const fixture = raw as {
      id: string;
      scenarioCount: number;
      scenarios: Array<{
        observedN: number;
        observedDaysWithTrades: number;
        observedMinClosedTrades: number;
        priorActiveTier: CellWeightsTier | null;
        expectedTier: CellWeightsTier;
      }>;
    };
    let mismatches = 0;
    let firstMismatch: typeof fixture.scenarios[number] | null = null;
    let firstMismatchGot: CellWeightsTier | null = null;
    for (const s of fixture.scenarios) {
      const got = selectCellWeightsTier(
        s.observedN,
        s.observedDaysWithTrades,
        s.observedMinClosedTrades,
        s.priorActiveTier,
      );
      if (got !== s.expectedTier) {
        mismatches++;
        if (!firstMismatch) {
          firstMismatch = s;
          firstMismatchGot = got;
        }
      }
    }
    const ok = mismatches === 0;
    console.log(
      `${ok ? '✓' : '✗'} ${fixture.id}  scenarios=${fixture.scenarios.length}  ` +
        `mismatches=${mismatches}`,
    );
    if (!ok && firstMismatch) {
      console.log(
        `  first mismatch: N=${firstMismatch.observedN} ` +
          `days=${firstMismatch.observedDaysWithTrades} ` +
          `trades=${firstMismatch.observedMinClosedTrades} ` +
          `prior=${firstMismatch.priorActiveTier} ` +
          `→ TS=${firstMismatchGot} Py=${firstMismatch.expectedTier}`,
      );
      failed++;
    }
    tierParityChecked = true;
    continue;
  }

  // --- HRP weights fixture (id prefix `hrp_*`) ---
  if (!id.startsWith('hrp_')) {
    // Unknown shape — skip rather than blindly casting (avoids a confusing
    // TypeError if a future contributor drops a different fixture shape
    // into this directory).
    console.log(`· ${id || f}  (unknown fixture shape — skipped)`);
    continue;
  }
  const record = raw as {
    id: string;
    input: {
      cellKeys: string[];
      dailyReturns: Record<string, number[]>;
      closedTradeCounts: Record<string, number>;
      observedDays: Record<string, number>;
      tier: string;
      priorActiveTier: 'T0' | 'T1' | 'T2' | null;
    };
    expected: { tierActive: string; weights: Record<string, number> };
  };
  const inp = record.input;
  const r = computeCellWeights({
    cellKeys: inp.cellKeys,
    dailyReturns: new Map(Object.entries(inp.dailyReturns)),
    closedTradeCounts: new Map(Object.entries(inp.closedTradeCounts)),
    observedDays: new Map(Object.entries(inp.observedDays)),
    tier: inp.tier as CellWeightsTierInput,
    priorActiveTier: inp.priorActiveTier,
  });
  let maxDiff = 0;
  for (const k of inp.cellKeys) {
    const got = r.weights.get(k)!;
    const want = record.expected.weights[k];
    const diff = Math.abs(got - want);
    if (diff > maxDiff) maxDiff = diff;
  }
  const ok = r.tierActive === record.expected.tierActive && maxDiff < 1e-9;
  console.log(
    `${ok ? '✓' : '✗'} ${record.id}  tier=${r.tierActive}  maxDiff=${maxDiff.toExponential(2)}`,
  );
  if (!ok) {
    console.log(`  got      :`, [...r.weights.entries()].map(([k, v]) => `${k}=${v.toFixed(12)}`).join(', '));
    console.log(`  expected :`, Object.entries(record.expected.weights).map(([k, v]) => `${k}=${v.toFixed(12)}`).join(', '));
    failed++;
  }
  hrpCount++;
}

if (failed > 0) {
  console.error(`\n${failed} fixture(s) failed`);
  process.exit(1);
}
console.log(
  `\nAll ${hrpCount} HRP fixtures match within 1e-9.` +
    (tierParityChecked ? ` Tier-selection parity OK on all scenarios.` : ''),
);
