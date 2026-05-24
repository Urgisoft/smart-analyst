/**
 * Tests for scripts/_backfill_sector_rotation_snapshots.ts — Cycle 25
 * Composite worker's Tier-1 backfill helper per S96-117 carve-out.
 *
 * The script's primary entry point (backfillSectorRotationSnapshots) is
 * I/O-bound on live CH. These tests focus on:
 *   1. Default window constant pins (SPEC §S-PBSR1-5 alignment).
 *   2. Structural pins on the helper-reuse guarantee (no logic
 *      re-implementation per S96-117 gate 3).
 *   3. CLI argument-parsing surface (--apply, --start, --end).
 *   4. Cross-script convention alignment (with probe).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WINDOW_START,
} from '../_backfill_sector_rotation_snapshots.js';

describe('Backfill SPEC-pinned constants', () => {
  it('DEFAULT_WINDOW_START = "2013-01-03" per SPEC §S-PBSR1-5', () => {
    assert.equal(DEFAULT_WINDOW_START, '2013-01-03');
  });
  it('DEFAULT_WINDOW_START matches probe REQUIRED_WINDOW_START', async () => {
    // Anti-drift: the backfill window must align with the probe's
    // expected coverage window. A divergence would cause the probe to
    // continue reporting 'ambiguous' after backfill.
    const probeModule = await import('../_probe_phase_b_sector_rot_v1_inputs.js');
    assert.equal(DEFAULT_WINDOW_START, probeModule.REQUIRED_WINDOW_START);
  });
});

describe('Backfill helper-reuse pins (S96-117 gate 3 — no re-implementation)', () => {
  it('script source imports SectorRotationRepository (canonical I/O)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_sector_rotation_snapshots.ts', 'utf-8'),
    );
    assert.match(src, /import\s*\{[^}]*SectorRotationRepository[^}]*\}\s*from\s*['"]\.\.\/src\/server\/sector_rotation_repository\.js['"]/,
      'backfill must import SectorRotationRepository (canonical I/O), not roll its own');
  });
  it('script source imports computeSectorRotation (canonical composite logic)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_sector_rotation_snapshots.ts', 'utf-8'),
    );
    assert.match(src, /import\s*\{[^}]*computeSectorRotation[^}]*\}\s*from\s*['"]\.\.\/src\/server\/sector_rotation\.js['"]/,
      'backfill must import computeSectorRotation (canonical composite), not roll its own');
  });
  it('script source uses repo.readInputsForCycle (canonical orchestration)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_sector_rotation_snapshots.ts', 'utf-8'),
    );
    assert.match(src, /repo\.readInputsForCycle\(/);
  });
  it('script source uses repo.writeSnapshot (canonical persist)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_sector_rotation_snapshots.ts', 'utf-8'),
    );
    assert.match(src, /repo\.writeSnapshot\(/);
  });
  it('script does NOT re-implement defensiveCyclicalSpreadZ math (no inline z-score)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_sector_rotation_snapshots.ts', 'utf-8'),
    );
    // The repository's computeZ is the only canonical implementation.
    // The backfill MUST NOT re-implement (value - mean) / stddev or define
    // its own DEFENSIVE_SECTORS/CYCLICAL_SECTORS arrays.
    assert.ok(!src.match(/\(value\s*-\s*mean\)\s*\/\s*stddev/i),
      'backfill must not inline z-score formula (use computeSectorRotation)');
    assert.ok(!src.match(/const\s+DEFENSIVE_SECTORS\s*=/),
      'backfill must not redefine DEFENSIVE_SECTORS (use sector_rotation.ts export)');
  });
});

describe('Backfill calendar choice — SPY_USD as the canonical US trading day series', () => {
  it('script source uses SPY_USD as the trading-day calendar (NOT VIX_USD)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_sector_rotation_snapshots.ts', 'utf-8'),
    );
    // VIX_USD is the vol_struct_v1 calendar; sector_rot_v1 uses SPY_USD
    // (parity with the composite's SPY 52w-high context). Either is valid
    // (SPY/VIX share the US equity trading-day calendar) but a copy-paste
    // from vol_struct_v1's backfill that left VIX_USD in would be a
    // semantic mistake.
    assert.match(src, /token_address\s*=\s*'SPY_USD'/);
  });
});

describe('Backfill CLI surface', () => {
  it('help entry registered for npm script discovery', async () => {
    const mod = await import('../_backfill_sector_rotation_snapshots.js');
    assert.ok(Array.isArray(mod.help) && mod.help.length > 0,
      'help array must be present + non-empty');
    assert.equal(mod.help[0].npm, '_backfill:sector_rotation_snapshots');
    assert.equal(mod.help[0].category, 'Data quality');
  });
});
