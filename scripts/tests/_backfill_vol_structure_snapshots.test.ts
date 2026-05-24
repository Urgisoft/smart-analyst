/**
 * Tests for scripts/_backfill_vol_structure_snapshots.ts — Cycle 24
 * Composite worker's Tier-1 backfill helper per S96-117 carve-out.
 *
 * The script's primary entry point (backfillVolStructureSnapshots) is
 * I/O-bound on live CH. These tests focus on:
 *   1. Default window constant pins (SPEC §S-PBV1-5 alignment).
 *   2. Structural pins on the helper-reuse guarantee (no logic
 *      re-implementation per S96-117 gate 3).
 *   3. CLI argument-parsing surface (--apply, --start, --end).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WINDOW_START,
} from '../_backfill_vol_structure_snapshots.js';

describe('Backfill SPEC-pinned constants', () => {
  it('DEFAULT_WINDOW_START = "2013-01-03" per SPEC §S-PBV1-5', () => {
    assert.equal(DEFAULT_WINDOW_START, '2013-01-03');
  });
  it('DEFAULT_WINDOW_START matches probe REQUIRED_WINDOW_START', async () => {
    // Anti-drift: the backfill window must align with the probe's
    // expected coverage window. A divergence would cause the probe to
    // continue reporting 'ambiguous' after backfill.
    const probeModule = await import('../_probe_phase_b_vol_struct_v1_inputs.js');
    assert.equal(DEFAULT_WINDOW_START, probeModule.REQUIRED_WINDOW_START);
  });
});

describe('Backfill helper-reuse pins (S96-117 gate 3 — no re-implementation)', () => {
  it('script source imports VolStructureRepository (canonical I/O)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_vol_structure_snapshots.ts', 'utf-8'),
    );
    assert.match(src, /import\s*\{[^}]*VolStructureRepository[^}]*\}\s*from\s*['"]\.\.\/src\/server\/vol_structure_repository\.js['"]/,
      'backfill must import VolStructureRepository (canonical I/O), not roll its own');
  });
  it('script source imports computeVolStructure (canonical composite logic)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_vol_structure_snapshots.ts', 'utf-8'),
    );
    assert.match(src, /import\s*\{[^}]*computeVolStructure[^}]*\}\s*from\s*['"]\.\.\/src\/server\/vol_structure\.js['"]/,
      'backfill must import computeVolStructure (canonical composite), not roll its own');
  });
  it('script source uses repo.readInputsForCycle (canonical orchestration)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_vol_structure_snapshots.ts', 'utf-8'),
    );
    assert.match(src, /repo\.readInputsForCycle\(/);
  });
  it('script source uses repo.writeSnapshot (canonical persist)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_vol_structure_snapshots.ts', 'utf-8'),
    );
    assert.match(src, /repo\.writeSnapshot\(/);
  });
  it('script does NOT re-implement curveSteepnessZ math (no inline formula)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_vol_structure_snapshots.ts', 'utf-8'),
    );
    // The repository's computeSteepnessSeries is the only canonical
    // implementation. The backfill MUST NOT re-implement (VIX6M - VIX9D) / VIX.
    assert.ok(!src.match(/\(vix6m\s*-\s*vix9d\)\s*\/\s*vix/i),
      'backfill must not inline curveSteepness formula (use computeVolStructure)');
  });
});

describe('Backfill CLI surface', () => {
  it('help entry registered for npm script discovery', async () => {
    const mod = await import('../_backfill_vol_structure_snapshots.js');
    assert.ok(Array.isArray(mod.help) && mod.help.length > 0,
      'help array must be present + non-empty');
    assert.equal(mod.help[0].npm, '_backfill:vol_structure_snapshots');
    assert.equal(mod.help[0].category, 'Data quality');
  });
});
