/**
 * Tests for scripts/_backfill_cross_asset_snapshots.ts — Cycle 26
 * Composite worker's Tier-1 backfill helper per S96-117 carve-out.
 *
 * The script's primary entry point (backfillCrossAssetSnapshots) is
 * I/O-bound on live CH. These tests focus on:
 *   1. Default window constant pins (SPEC §S-PBCA1-5 alignment).
 *   2. Structural pins on the helper-reuse guarantee (no logic
 *      re-implementation per S96-117 gate 3).
 *   3. CLI argument-parsing surface (--apply, --start, --end).
 *   4. Cross-script convention alignment (with probe).
 *   5. writeSnapshot signature pin (1-arg, NOT 2-arg like sector_rot's).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WINDOW_START,
} from '../_backfill_cross_asset_snapshots.js';

describe('Backfill SPEC-pinned constants', () => {
  it('DEFAULT_WINDOW_START = "2013-01-03" per SPEC §S-PBCA1-5', () => {
    assert.equal(DEFAULT_WINDOW_START, '2013-01-03');
  });
  it('DEFAULT_WINDOW_START matches probe REQUIRED_WINDOW_START', async () => {
    // Anti-drift: the backfill window must align with the probe's
    // expected coverage window. A divergence would cause the probe to
    // continue reporting 'ambiguous' after backfill.
    const probeModule = await import('../_probe_phase_b_cross_asset_v1_inputs.js');
    assert.equal(DEFAULT_WINDOW_START, probeModule.REQUIRED_WINDOW_START);
  });
});

describe('Backfill helper-reuse pins (S96-117 gate 3 — no re-implementation)', () => {
  it('script source imports CrossAssetSignalsRepository (canonical I/O)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_cross_asset_snapshots.ts', 'utf-8'),
    );
    assert.match(
      src,
      /import\s*\{[^}]*CrossAssetSignalsRepository[^}]*\}\s*from\s*['"]\.\.\/src\/server\/cross_asset_snapshots_repository\.js['"]/,
      'backfill must import CrossAssetSignalsRepository (canonical I/O), not roll its own',
    );
  });
  it('script source imports computeCrossAssetSignals (canonical composite logic)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_cross_asset_snapshots.ts', 'utf-8'),
    );
    assert.match(
      src,
      /import\s*\{[^}]*computeCrossAssetSignals[^}]*\}\s*from\s*['"]\.\.\/src\/server\/cross_asset_signals\.js['"]/,
      'backfill must import computeCrossAssetSignals (canonical composite), not roll its own',
    );
  });
  it('script source uses repo.readInputsForCycle (canonical orchestration)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_cross_asset_snapshots.ts', 'utf-8'),
    );
    assert.match(src, /repo\.readInputsForCycle\(/);
  });
  it('script source uses repo.writeSnapshot (canonical persist)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_cross_asset_snapshots.ts', 'utf-8'),
    );
    assert.match(src, /repo\.writeSnapshot\(/);
  });
  it('script does NOT re-implement copper/gold ratio math (no inline formula)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_cross_asset_snapshots.ts', 'utf-8'),
    );
    // The repository's computeCopperGoldRatioChange is the canonical
    // implementation. The backfill MUST NOT re-implement
    // (copxToday / gldToday) / (copxThen / gldThen) - 1 OR define its
    // own COPX/GLD threshold constants.
    assert.ok(!src.match(/copxToday\s*\/\s*gldToday/i),
      'backfill must not inline copper/gold ratio formula (use computeCrossAssetSignals)');
    assert.ok(!src.match(/COMMODITY_GROWTH_COLLAPSE_THRESHOLD\s*=/),
      'backfill must not redefine COMMODITY_GROWTH_COLLAPSE_THRESHOLD (use cross_asset_signals.ts export)');
  });
});

describe('Backfill writeSnapshot signature — 1-arg (NOT 2-arg like sector_rot_v1)', () => {
  it('script source calls repo.writeSnapshot(snapshot) with single arg', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_cross_asset_snapshots.ts', 'utf-8'),
    );
    // CrossAssetSignalsRepository.writeSnapshot takes (snapshot) only;
    // sector_rotation_repository's writeSnapshot takes (snapshot, inputs).
    // A copy-paste from _backfill_sector_rotation_snapshots.ts that left
    // `writeSnapshot(snapshot, inputs)` would type-error in tsc; this
    // source-text test catches it at integration time too.
    // Reject 2-arg form:
    assert.ok(!src.match(/repo\.writeSnapshot\(\s*\w+\s*,\s*\w+\s*\)/),
      'backfill must NOT call writeSnapshot with 2 args ' +
      '(CrossAssetSignalsRepository.writeSnapshot takes only `snapshot`)');
    // Confirm 1-arg form is present:
    assert.match(src, /repo\.writeSnapshot\(\s*\w+\s*\)/,
      'backfill must call writeSnapshot with exactly 1 arg (the snapshot)');
  });
});

describe('Backfill calendar choice — SPY_USD per CANON-THIN DECISIONS', () => {
  it('script source uses SPY_USD as the trading-day calendar (NOT VIX_USD)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_backfill_cross_asset_snapshots.ts', 'utf-8'),
    );
    // SPY_USD is the canonical US-equity trading-day series; matches
    // sector_rot_v1's Cycle 25 calendar choice (S96-125). vol_struct_v1
    // used VIX_USD because VIX was its composite's load-bearing input;
    // cross_asset_v1 has no single load-bearing US-equity input, so
    // SPY_USD is the natural fallback.
    assert.match(src, /token_address\s*=\s*'SPY_USD'/);
    // Reject leftover VIX_USD from vol_struct_v1 backfill copy-paste:
    assert.ok(!src.match(/token_address\s*=\s*'VIX_USD'/),
      'backfill must NOT use VIX_USD as calendar (vol_struct_v1 choice)');
  });
});

describe('Backfill CLI surface', () => {
  it('help entry registered for npm script discovery', async () => {
    const mod = await import('../_backfill_cross_asset_snapshots.js');
    assert.ok(Array.isArray(mod.help) && mod.help.length > 0,
      'help array must be present + non-empty');
    assert.equal(mod.help[0].npm, '_backfill:cross_asset_snapshots');
    assert.equal(mod.help[0].category, 'Data quality');
  });
});
