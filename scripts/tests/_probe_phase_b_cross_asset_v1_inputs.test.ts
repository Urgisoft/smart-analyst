/**
 * Tests for scripts/_probe_phase_b_cross_asset_v1_inputs.ts — Cycle 26
 * Composite worker's Step 0 pre-flight probe.
 *
 * The probe itself is I/O-bound (requires live CH); these tests focus on:
 *   1. SPEC-pinned thresholds + window constants (anti-drift convention pins).
 *   2. Structural pins on the probe's helper logic that we can exercise
 *      without a live CH instance (the snapshots-state classifier is the
 *      load-bearing branch — empty vs full vs ambiguous routing differs).
 *   3. Cross-probe parity with vol_struct_v1 + sector_rot_v1 probes.
 *
 * A live-CH integration test (full probe run) would belong in a tests/integration
 * subtree; per project convention (tsx --test scripts/tests/*.test.ts) we keep
 * these as unit-shaped pins.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_WINDOW_START,
  SPARSE_ROW_THRESHOLD,
  REQUIRED_EARLIEST_DATE_MAX,
  EMPTY_OR_FORWARD_ONLY_ROW_THRESHOLD,
  FORWARD_ONLY_EARLIEST_DATE_MIN,
  EXPECTED_FULL_WINDOW_ROWS,
} from '../_probe_phase_b_cross_asset_v1_inputs.js';

describe('Probe SPEC constants — anti-drift pins', () => {
  it('REQUIRED_WINDOW_START = "2013-01-03" per SPEC §S-PBCA1-5', () => {
    assert.equal(REQUIRED_WINDOW_START, '2013-01-03');
  });
  it('SPARSE_ROW_THRESHOLD ≥ 2500 (≈ 10y of US trading days)', () => {
    // The probe treats anything below this as not-yet-full coverage.
    // 2500 trading days ≈ 9.92 years on the 252-day/year US calendar.
    assert.ok(SPARSE_ROW_THRESHOLD >= 2500,
      `SPARSE_ROW_THRESHOLD=${SPARSE_ROW_THRESHOLD} too low for SPEC IS window`);
  });
  it('REQUIRED_EARLIEST_DATE_MAX ≤ 2014-01-01 (cross-arc anti-drift)', () => {
    // cross_asset_v1's selected score has no per-day baseline, but we match
    // the predecessor probes' threshold for cross-probe parity.
    assert.ok(REQUIRED_EARLIEST_DATE_MAX <= '2014-01-01',
      `REQUIRED_EARLIEST_DATE_MAX=${REQUIRED_EARLIEST_DATE_MAX} too lenient`);
  });
  it('EMPTY_OR_FORWARD_ONLY_ROW_THRESHOLD = 200 (spawn-brief "≈200")', () => {
    // Spawn brief: "If row count is small (e.g., < 200) OR earliest_date
    // is recent (> 2024): invoke S96-117 Tier-1 carve-out".
    assert.equal(EMPTY_OR_FORWARD_ONLY_ROW_THRESHOLD, 200);
  });
  it('FORWARD_ONLY_EARLIEST_DATE_MIN = "2025-01-01" (spawn-brief "> 2024")', () => {
    assert.equal(FORWARD_ONLY_EARLIEST_DATE_MIN, '2025-01-01');
  });
  it('EXPECTED_FULL_WINDOW_ROWS ≈ 3250 (SPEC §S-PBCA1-5)', () => {
    // Spec predicts ~3,250 trading days from 2013-01-03 → today.
    assert.ok(EXPECTED_FULL_WINDOW_ROWS >= 3000 && EXPECTED_FULL_WINDOW_ROWS <= 3500,
      `EXPECTED_FULL_WINDOW_ROWS=${EXPECTED_FULL_WINDOW_ROWS} outside [3000, 3500]`);
  });
});

describe('Probe state-classifier thresholds — non-overlap pin', () => {
  it('full and empty classifiers do not both fire (full threshold > forward-only)', () => {
    // If SPARSE_ROW_THRESHOLD ≤ EMPTY_OR_FORWARD_ONLY_ROW_THRESHOLD,
    // a row count in [200, sparse] would qualify as BOTH 'full' (≥sparse)
    // and 'empty/forward-only' (≤200). The classifier walks empty first
    // so the 'empty' bucket would win, but this is a degenerate ordering.
    assert.ok(SPARSE_ROW_THRESHOLD > EMPTY_OR_FORWARD_ONLY_ROW_THRESHOLD,
      'sparse-threshold must exceed forward-only-threshold by a margin');
  });
  it('full-coverage threshold > forward-only earliest_date (date ordering)', () => {
    // FORWARD_ONLY_EARLIEST_DATE_MIN ≥ 2025; REQUIRED_EARLIEST_DATE_MAX ≤ 2014.
    // The two cutoffs are mutually exclusive — a snapshots row from 2025
    // CAN'T also be a historical 2013 row, so the classifier branches
    // are safe (no row range satisfies both).
    assert.ok(REQUIRED_EARLIEST_DATE_MAX < FORWARD_ONLY_EARLIEST_DATE_MIN,
      `REQUIRED_EARLIEST_DATE_MAX (${REQUIRED_EARLIEST_DATE_MAX}) must precede ` +
      `FORWARD_ONLY_EARLIEST_DATE_MIN (${FORWARD_ONLY_EARLIEST_DATE_MIN})`);
  });
});

describe('Probe constants — alignment with predecessor probes (cross-arc parity)', () => {
  it('REQUIRED_WINDOW_START matches sector_rot_v1 probe (cross-composite parity)', async () => {
    // SPEC §S-PBCA1-5: match predecessors' window for cross-composite
    // meta-HLZ aggregation at 9-arc completion.
    const sectorRotProbe = await import('../_probe_phase_b_sector_rot_v1_inputs.js');
    assert.equal(REQUIRED_WINDOW_START, sectorRotProbe.REQUIRED_WINDOW_START);
  });
  it('thresholds match sector_rot_v1 (anti-drift across probes)', async () => {
    const sectorRotProbe = await import('../_probe_phase_b_sector_rot_v1_inputs.js');
    assert.equal(SPARSE_ROW_THRESHOLD, sectorRotProbe.SPARSE_ROW_THRESHOLD);
    assert.equal(REQUIRED_EARLIEST_DATE_MAX, sectorRotProbe.REQUIRED_EARLIEST_DATE_MAX);
    assert.equal(EMPTY_OR_FORWARD_ONLY_ROW_THRESHOLD,
      sectorRotProbe.EMPTY_OR_FORWARD_ONLY_ROW_THRESHOLD);
    assert.equal(FORWARD_ONLY_EARLIEST_DATE_MIN,
      sectorRotProbe.FORWARD_ONLY_EARLIEST_DATE_MIN);
  });
  it('REQUIRED_WINDOW_START matches vol_struct_v1 probe (cross-composite parity)', async () => {
    const volStructProbe = await import('../_probe_phase_b_vol_struct_v1_inputs.js');
    assert.equal(REQUIRED_WINDOW_START, volStructProbe.REQUIRED_WINDOW_START);
  });
});

describe('Probe column-name convention pin', () => {
  it('probe source references copper_gold_ratio_20d_change_pct (NOT defensive_cyclical_spread_z)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_probe_phase_b_cross_asset_v1_inputs.ts', 'utf-8'),
    );
    assert.match(src, /copper_gold_ratio_20d_change_pct/,
      'probe must reference copper_gold_ratio_20d_change_pct (the score column)');
    // Belt-and-suspenders: ensure no leftover defensive_cyclical_spread_z
    // from copy-paste of sector_rot_v1 probe.
    assert.ok(!src.match(/defensive_cyclical_spread_z/i),
      'probe must NOT reference defensive_cyclical_spread_z (sector_rot_v1 column)');
    // And no curve_steepness_z from vol_struct_v1 either.
    assert.ok(!src.match(/curve_steepness_z/i),
      'probe must NOT reference curve_steepness_z (vol_struct_v1 column)');
  });
  it('probe source references cross_asset_snapshots (NOT sector_rotation_snapshots)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_probe_phase_b_cross_asset_v1_inputs.ts', 'utf-8'),
    );
    assert.match(src, /cross_asset_snapshots/);
    assert.ok(!src.match(/sector_rotation_snapshots/i),
      'probe must NOT reference sector_rotation_snapshots (sector_rot_v1 table)');
    assert.ok(!src.match(/vol_structure_snapshots/i),
      'probe must NOT reference vol_structure_snapshots (vol_struct_v1 table)');
  });
  it('probe source references GLD_USD + COPX_USD (the score-source tokens)', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync('scripts/_probe_phase_b_cross_asset_v1_inputs.ts', 'utf-8'),
    );
    assert.match(src, /GLD_USD/, 'probe must check GLD_USD candle coverage');
    assert.match(src, /COPX_USD/, 'probe must check COPX_USD candle coverage');
    // Sanity: no leftover sector ETF references.
    assert.ok(!src.match(/XLP_USD|XLU_USD|XLV_USD|XLY_USD|XLK_USD|XLF_USD/),
      'probe must NOT reference sector ETFs (sector_rot_v1 score sources)');
  });
});
