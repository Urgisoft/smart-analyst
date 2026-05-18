/**
 * Lockstep contract test — PARAM_GRID coarse value MUST be identical across
 * scripts/batch_backtest.ts and scripts/watch_candles.ts. Per ADR-016, divergence
 * causes the candle-watcher daemon to append bt_runs rows at one grid while
 * sweeps land at another, silently corrupting per-cell K_dsr in score_strategies
 * output. This test pins the contract by source-text comparison so it fails
 * loudly the moment one file is changed without the other.
 *
 * Source-text matching (not import) is intentional: importing batch_backtest.ts
 * triggers its CLI parsing + worker pool startup at module-load time. Reading
 * the source as text is the cheap, side-effect-free way to verify the constant.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function extractCoarseGrid(filePath: string): number[] {
  const src = readFileSync(filePath, 'utf8');
  // Match the coarse-grid array literal — the line that ends with the ADR-016 marker
  // comment, OR the bare ': [<numbers>]' branch in the GRID === 'full' ternary.
  const m = src.match(/:\s*\[\s*((?:\d+\s*,\s*)+\d+)\s*\];?\s*(?:\/\/[^\n]*ADR-016[^\n]*)?/);
  if (!m) throw new Error(`coarse PARAM_GRID literal not found in ${filePath}`);
  return m[1].split(',').map(s => parseInt(s.trim(), 10));
}

describe('PARAM_GRID coarse-value lockstep — ADR-016 contract', () => {
  it('batch_backtest.ts and watch_candles.ts share the same coarse grid', () => {
    const batchGrid = extractCoarseGrid(resolve(REPO_ROOT, 'scripts', 'batch_backtest.ts'));
    const watchGrid = extractCoarseGrid(resolve(REPO_ROOT, 'scripts', 'watch_candles.ts'));
    assert.deepEqual(
      batchGrid, watchGrid,
      `coarse PARAM_GRID has diverged between batch_backtest.ts (${batchGrid.join(',')}) ` +
      `and watch_candles.ts (${watchGrid.join(',')}). Per ADR-016 these MUST stay in lockstep — ` +
      `a divergence causes the watcher daemon to append bt_runs rows at one grid while ` +
      `sweeps land at another, corrupting K_dsr counts in score_strategies output. ` +
      `If the grid is intentionally being changed, update both files in the same commit.`,
    );
  });

  it('coarse grid matches the ADR-016 specification [3,5,7,10,14,20,30,50]', () => {
    const expected = [3, 5, 7, 10, 14, 20, 30, 50];
    const actual = extractCoarseGrid(resolve(REPO_ROOT, 'scripts', 'batch_backtest.ts'));
    assert.deepEqual(
      actual, expected,
      `coarse PARAM_GRID is ${actual.join(',')} but ADR-016 specifies ${expected.join(',')}. ` +
      `If a new grid is being adopted, supersede ADR-016 with a new ADR documenting the ` +
      `methodology rationale + bt_runs housekeeping plan, then update this expected value.`,
    );
  });
});
