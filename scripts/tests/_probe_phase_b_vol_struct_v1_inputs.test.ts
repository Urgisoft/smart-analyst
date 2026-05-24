/**
 * Tests for scripts/_probe_phase_b_vol_struct_v1_inputs.ts — Cycle 24
 * Composite worker's Step 0 pre-flight probe.
 *
 * The probe itself is I/O-bound (requires live CH); these tests focus on:
 *   1. SPEC-pinned thresholds + window constants (anti-drift convention pins).
 *   2. Structural pins on the probe's helper logic that we can exercise
 *      without a live CH instance (the snapshots-state classifier is the
 *      load-bearing branch — empty vs full vs ambiguous routing differs).
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
} from '../_probe_phase_b_vol_struct_v1_inputs.js';

describe('Probe SPEC constants — anti-drift pins', () => {
  it('REQUIRED_WINDOW_START = "2013-01-03" per SPEC §S-PBV1-5', () => {
    assert.equal(REQUIRED_WINDOW_START, '2013-01-03');
  });
  it('SPARSE_ROW_THRESHOLD ≥ 2500 (≈ 10y of US trading days)', () => {
    // The probe treats anything below this as not-yet-full coverage.
    // 2500 trading days ≈ 9.92 years on the 252-day/year US calendar.
    assert.ok(SPARSE_ROW_THRESHOLD >= 2500,
      `SPARSE_ROW_THRESHOLD=${SPARSE_ROW_THRESHOLD} too low for SPEC IS window`);
  });
  it('REQUIRED_EARLIEST_DATE_MAX ≤ 2014-01-01 (full-strength baseline)', () => {
    // Snapshots earliest_date must precede 2014-01-01 for the trailing-2y
    // baseline to be fully populated at SPEC IS_START (= 2013-01-03).
    // The threshold should be at or before 2014-01-01 — slightly later
    // values would let through partial baselines.
    assert.ok(REQUIRED_EARLIEST_DATE_MAX <= '2014-01-01',
      `REQUIRED_EARLIEST_DATE_MAX=${REQUIRED_EARLIEST_DATE_MAX} too lenient`);
  });
  it('EMPTY_OR_FORWARD_ONLY_ROW_THRESHOLD matches spawn-brief "≈200"', () => {
    // Spawn brief: "If row count is small (e.g., < 200) OR earliest_date
    // is recent (> 2024): invoke S96-117 Tier-1 carve-out".
    assert.equal(EMPTY_OR_FORWARD_ONLY_ROW_THRESHOLD, 200);
  });
  it('FORWARD_ONLY_EARLIEST_DATE_MIN matches spawn-brief "> 2024"', () => {
    // We use >= 2025-01-01 as the operational cutoff (the spawn brief
    // phrasing "> 2024" means earliest_date in 2025 or later).
    assert.equal(FORWARD_ONLY_EARLIEST_DATE_MIN, '2025-01-01');
  });
  it('EXPECTED_FULL_WINDOW_ROWS ≈ 3250 (SPEC §S-PBV1-5)', () => {
    // Spec predicts ~3,250 trading days from 2013-01-03 → today
    // (today ≈ 2026-05-24 means ~13.4 years × 252 ≈ 3,377; SPEC's 3,250
    // is the rough size estimate; actual count varies with date).
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
