/**
 * Unit tests for `computeSectorRotation` — SPEC §7.
 *
 * Pure-function coverage:
 *   - Measurements 1-10 (returns, spreads, top sector, SPY context, G/V).
 *   - Flags: defensiveLeadActive, concentrationExtremeActive.
 *   - Regime-flag priority order at every transition.
 *   - inputsPresent bitmask.
 *   - Composite version pin.
 *
 * No I/O, no CH, no fixtures beyond the helpers below.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  computeSectorRotation,
  type SectorRotationInputs,
  type TrackedSectorSymbol,
  SECTOR_ROT_COMPOSITE_VERSION,
  TRACKED_SECTORS,
  DEFENSIVE_SECTORS,
  CYCLICAL_SECTORS,
  DEFENSIVE_LEAD_Z_THRESHOLD,
  CONCENTRATION_EXTREME_Z_THRESHOLD,
  SPY_HIGH_PROXIMITY_THRESHOLD,
  INPUT_DEFENSIVE_RETURNS,
  INPUT_CYCLICAL_RETURNS,
  INPUT_SECTOR_VOLUMES,
  INPUT_SPY_CONTEXT,
  INPUT_GROWTH_VALUE,
  INPUT_Z_BASELINES,
} from '../../src/server/sector_rotation.js';

const AS_OF = new Date('2026-05-19T00:00:00Z');

function returnsAll(value: number | null): Record<TrackedSectorSymbol, number | null> {
  const out = {} as Record<TrackedSectorSymbol, number | null>;
  for (const s of TRACKED_SECTORS) out[s] = value;
  return out;
}

function volumesAll(value: number | null): Record<TrackedSectorSymbol, number | null> {
  const out = {} as Record<TrackedSectorSymbol, number | null>;
  for (const s of TRACKED_SECTORS) out[s] = value;
  return out;
}

function baseInputs(overrides: Partial<SectorRotationInputs> = {}): SectorRotationInputs {
  return {
    asOf: AS_OF,
    sectorReturns20d: returnsAll(0.01),
    sectorAvgDollarVolume20d: volumesAll(1_000_000_000),
    spyClose: 500,
    spy52wHigh: 500,
    iwfReturn20d: 0.02,
    iwdReturn20d: 0.01,
    defensiveCyclicalSpreadZScore: 0,
    topSectorVolumeShareZScore: 0,
    ...overrides,
  };
}

// ───── Measurements 1 + 2 (defensive / cyclical mean) ──────────────────

test('defensive20dReturn = mean of XLP/XLU/XLV returns', () => {
  const returns = returnsAll(0);
  returns.XLP = 0.02;
  returns.XLU = 0.04;
  returns.XLV = 0.06;
  const snap = computeSectorRotation(baseInputs({ sectorReturns20d: returns }));
  assert.equal(snap.defensive20dReturn, (0.02 + 0.04 + 0.06) / 3);
});

test('defensive20dReturn is null when XLP missing', () => {
  const returns = returnsAll(0.01);
  returns.XLP = null;
  const snap = computeSectorRotation(baseInputs({ sectorReturns20d: returns }));
  assert.equal(snap.defensive20dReturn, null);
});

test('defensive20dReturn is null when all defensives missing', () => {
  const returns = returnsAll(0.01);
  for (const s of DEFENSIVE_SECTORS) returns[s] = null;
  const snap = computeSectorRotation(baseInputs({ sectorReturns20d: returns }));
  assert.equal(snap.defensive20dReturn, null);
});

test('cyclical20dReturn = mean of XLY/XLK/XLF returns', () => {
  const returns = returnsAll(0);
  returns.XLY = -0.01;
  returns.XLK = -0.03;
  returns.XLF = -0.05;
  const snap = computeSectorRotation(baseInputs({ sectorReturns20d: returns }));
  assert.equal(snap.cyclical20dReturn, (-0.01 + -0.03 + -0.05) / 3);
});

test('cyclical20dReturn is null when XLK missing', () => {
  const returns = returnsAll(0.01);
  returns.XLK = null;
  const snap = computeSectorRotation(baseInputs({ sectorReturns20d: returns }));
  assert.equal(snap.cyclical20dReturn, null);
});

test('cyclical20dReturn is null when all cyclicals missing', () => {
  const returns = returnsAll(0.01);
  for (const s of CYCLICAL_SECTORS) returns[s] = null;
  const snap = computeSectorRotation(baseInputs({ sectorReturns20d: returns }));
  assert.equal(snap.cyclical20dReturn, null);
});

// ───── Measurement 3 (spread) ──────────────────────────────────────────

test('defensiveCyclicalSpread = defensive − cyclical when both present', () => {
  const returns = returnsAll(0);
  for (const s of DEFENSIVE_SECTORS) returns[s] = 0.05;
  for (const s of CYCLICAL_SECTORS) returns[s] = 0.01;
  const snap = computeSectorRotation(baseInputs({ sectorReturns20d: returns }));
  assert.ok(snap.defensiveCyclicalSpread != null);
  assert.ok(Math.abs((snap.defensiveCyclicalSpread as number) - 0.04) < 1e-9);
});

test('defensiveCyclicalSpread is null when defensive null', () => {
  const returns = returnsAll(0.01);
  returns.XLP = null;
  const snap = computeSectorRotation(baseInputs({ sectorReturns20d: returns }));
  assert.equal(snap.defensiveCyclicalSpread, null);
});

test('defensiveCyclicalSpread is null when cyclical null', () => {
  const returns = returnsAll(0.01);
  returns.XLY = null;
  const snap = computeSectorRotation(baseInputs({ sectorReturns20d: returns }));
  assert.equal(snap.defensiveCyclicalSpread, null);
});

// ───── Measurement 4 (z-score pass-through) ────────────────────────────

test('defensiveCyclicalSpreadZ passes through non-null input', () => {
  const snap = computeSectorRotation(baseInputs({ defensiveCyclicalSpreadZScore: 1.23 }));
  assert.equal(snap.defensiveCyclicalSpreadZ, 1.23);
});

test('defensiveCyclicalSpreadZ passes through null', () => {
  const snap = computeSectorRotation(baseInputs({ defensiveCyclicalSpreadZScore: null }));
  assert.equal(snap.defensiveCyclicalSpreadZ, null);
});

// ───── Measurements 5 + 6 (top sector / share) ─────────────────────────

test('topSectorSymbol = argmax over 11 sectors; share = top / total', () => {
  const volumes = volumesAll(1_000_000_000);
  volumes.XLK = 5_000_000_000;  // dominant
  const snap = computeSectorRotation(baseInputs({ sectorAvgDollarVolume20d: volumes }));
  assert.equal(snap.topSectorSymbol, 'XLK');
  // total = 10*1e9 + 5e9 = 15e9; share = 5e9/15e9 = 1/3
  assert.ok(snap.topSectorVolumeShare != null);
  assert.ok(Math.abs((snap.topSectorVolumeShare as number) - 1 / 3) < 1e-9);
});

test('topSectorSymbol returns XLRE when XLRE has the highest volume', () => {
  const volumes = volumesAll(1_000_000_000);
  volumes.XLRE = 3_000_000_000;
  const snap = computeSectorRotation(baseInputs({ sectorAvgDollarVolume20d: volumes }));
  assert.equal(snap.topSectorSymbol, 'XLRE');
});

test('topSectorSymbol is "" and share null when any sector volume missing', () => {
  const volumes = volumesAll(1_000_000_000);
  volumes.XLC = null;  // post-2018 carve-out missing
  const snap = computeSectorRotation(baseInputs({ sectorAvgDollarVolume20d: volumes }));
  assert.equal(snap.topSectorSymbol, '');
  assert.equal(snap.topSectorVolumeShare, null);
});

// ───── Measurement 7 (volume-share z pass-through) ─────────────────────

test('topSectorVolumeShareZ passes through input', () => {
  const snap = computeSectorRotation(baseInputs({ topSectorVolumeShareZScore: 2.5 }));
  assert.equal(snap.topSectorVolumeShareZ, 2.5);
});

// ───── Measurement 8 + 9 (SPY 52w context) ─────────────────────────────

test('spyPctOff52wHigh = 0 and within-5 = true when at 52w high', () => {
  const snap = computeSectorRotation(baseInputs({ spyClose: 500, spy52wHigh: 500 }));
  assert.equal(snap.spyPctOff52wHigh, 0);
  assert.equal(snap.spyWithin5PctOf52wHigh, true);
});

test('spyPctOff52wHigh = -0.03 and within-5 = true when 3% below', () => {
  const snap = computeSectorRotation(baseInputs({ spyClose: 485, spy52wHigh: 500 }));
  assert.ok(Math.abs((snap.spyPctOff52wHigh as number) - -0.03) < 1e-9);
  assert.equal(snap.spyWithin5PctOf52wHigh, true);
});

test('spyWithin5PctOf52wHigh = true at exactly 5% below (boundary inclusive)', () => {
  const snap = computeSectorRotation(baseInputs({ spyClose: 475, spy52wHigh: 500 }));
  assert.equal(snap.spyWithin5PctOf52wHigh, true);  // 475 ≥ 0.95 × 500 → true
});

test('spyWithin5PctOf52wHigh = false at 6% below', () => {
  const snap = computeSectorRotation(baseInputs({ spyClose: 470, spy52wHigh: 500 }));
  assert.equal(snap.spyWithin5PctOf52wHigh, false);
});

test('spy context missing → spyPctOff52wHigh null, within-5 false', () => {
  const snap = computeSectorRotation(baseInputs({ spyClose: null, spy52wHigh: null }));
  assert.equal(snap.spyPctOff52wHigh, null);
  assert.equal(snap.spyWithin5PctOf52wHigh, false);
});

// ───── Measurement 10 (growth/value) ───────────────────────────────────

test('growth/value spread = iwf − iwd when both present', () => {
  const snap = computeSectorRotation(baseInputs({ iwfReturn20d: 0.05, iwdReturn20d: 0.02 }));
  assert.equal(snap.growth20dReturn, 0.05);
  assert.equal(snap.value20dReturn, 0.02);
  assert.ok(Math.abs((snap.growthValueSpread as number) - 0.03) < 1e-9);
});

test('growth/value spread is null when iwf null', () => {
  const snap = computeSectorRotation(baseInputs({ iwfReturn20d: null, iwdReturn20d: 0.02 }));
  assert.equal(snap.growthValueSpread, null);
  assert.equal(snap.growth20dReturn, null);
  assert.equal(snap.value20dReturn, null);
});

test('growth/value spread is null when iwd null', () => {
  const snap = computeSectorRotation(baseInputs({ iwfReturn20d: 0.05, iwdReturn20d: null }));
  assert.equal(snap.growthValueSpread, null);
});

// ───── defensiveLeadActive flag ────────────────────────────────────────

test('defensiveLeadActive = true when z > 1.0 AND within 5% of 52w high', () => {
  const snap = computeSectorRotation(baseInputs({
    defensiveCyclicalSpreadZScore: 1.5,
    spyClose: 490,
    spy52wHigh: 500,
  }));
  assert.equal(snap.defensiveLeadActive, true);
});

test('defensiveLeadActive = false when z > 1.0 but SPY in drawdown', () => {
  const snap = computeSectorRotation(baseInputs({
    defensiveCyclicalSpreadZScore: 2.0,
    spyClose: 400,
    spy52wHigh: 500,
  }));
  assert.equal(snap.defensiveLeadActive, false);
});

test('defensiveLeadActive = false at exactly z=1.0 (strict greater-than)', () => {
  const snap = computeSectorRotation(baseInputs({
    defensiveCyclicalSpreadZScore: DEFENSIVE_LEAD_Z_THRESHOLD,
    spyClose: 500,
    spy52wHigh: 500,
  }));
  assert.equal(snap.defensiveLeadActive, false);
});

test('defensiveLeadActive = false when z null', () => {
  const snap = computeSectorRotation(baseInputs({ defensiveCyclicalSpreadZScore: null }));
  assert.equal(snap.defensiveLeadActive, false);
});

// ───── concentrationExtremeActive flag ─────────────────────────────────

test('concentrationExtremeActive = true when z > 1.5', () => {
  const snap = computeSectorRotation(baseInputs({ topSectorVolumeShareZScore: 1.7 }));
  assert.equal(snap.concentrationExtremeActive, true);
});

test('concentrationExtremeActive = false at exactly z=1.5 (strict greater-than)', () => {
  const snap = computeSectorRotation(baseInputs({
    topSectorVolumeShareZScore: CONCENTRATION_EXTREME_Z_THRESHOLD,
  }));
  assert.equal(snap.concentrationExtremeActive, false);
});

test('concentrationExtremeActive = false when z null', () => {
  const snap = computeSectorRotation(baseInputs({ topSectorVolumeShareZScore: null }));
  assert.equal(snap.concentrationExtremeActive, false);
});

// ───── regimeFlag priority order ───────────────────────────────────────

test('regimeFlag = severe_rotation when both flags active', () => {
  const snap = computeSectorRotation(baseInputs({
    defensiveCyclicalSpreadZScore: 1.5,
    spyClose: 495, spy52wHigh: 500,
    topSectorVolumeShareZScore: 1.7,
  }));
  assert.equal(snap.regimeFlag, 'severe_rotation');
});

test('regimeFlag = concentration_extreme when only concentration active', () => {
  const snap = computeSectorRotation(baseInputs({
    defensiveCyclicalSpreadZScore: 0.5,
    spyClose: 495, spy52wHigh: 500,
    topSectorVolumeShareZScore: 2.0,
  }));
  assert.equal(snap.regimeFlag, 'concentration_extreme');
});

test('regimeFlag = defensive_leadership when only defensive active', () => {
  const snap = computeSectorRotation(baseInputs({
    defensiveCyclicalSpreadZScore: 1.5,
    spyClose: 495, spy52wHigh: 500,
    topSectorVolumeShareZScore: 0,
  }));
  assert.equal(snap.regimeFlag, 'defensive_leadership');
});

test('regimeFlag = normal when neither flag active', () => {
  const snap = computeSectorRotation(baseInputs({
    defensiveCyclicalSpreadZScore: 0,
    topSectorVolumeShareZScore: 0,
  }));
  assert.equal(snap.regimeFlag, 'normal');
});

test('regimeFlag = unknown when z baselines missing', () => {
  const snap = computeSectorRotation(baseInputs({
    defensiveCyclicalSpreadZScore: null,
    topSectorVolumeShareZScore: null,
  }));
  assert.equal(snap.regimeFlag, 'unknown');
});

test('regimeFlag = unknown when sector volumes incomplete (carve-out era)', () => {
  const volumes = volumesAll(1_000_000_000);
  volumes.XLC = null;
  const snap = computeSectorRotation(baseInputs({ sectorAvgDollarVolume20d: volumes }));
  assert.equal(snap.regimeFlag, 'unknown');
});

test('regimeFlag = unknown when SPY context missing', () => {
  const snap = computeSectorRotation(baseInputs({ spyClose: null, spy52wHigh: null }));
  assert.equal(snap.regimeFlag, 'unknown');
});

test('regimeFlag = unknown when defensive returns missing', () => {
  const returns = returnsAll(0.01);
  returns.XLP = null;
  const snap = computeSectorRotation(baseInputs({ sectorReturns20d: returns }));
  assert.equal(snap.regimeFlag, 'unknown');
});

// ───── inputsPresent bitmask ───────────────────────────────────────────

test('inputsPresent = 63 (all 6 bits) on a fully present snapshot', () => {
  const snap = computeSectorRotation(baseInputs());
  assert.equal(snap.inputsPresent, 0b111111);
  assert.equal(snap.inputsPresent & INPUT_DEFENSIVE_RETURNS, INPUT_DEFENSIVE_RETURNS);
  assert.equal(snap.inputsPresent & INPUT_CYCLICAL_RETURNS, INPUT_CYCLICAL_RETURNS);
  assert.equal(snap.inputsPresent & INPUT_SECTOR_VOLUMES, INPUT_SECTOR_VOLUMES);
  assert.equal(snap.inputsPresent & INPUT_SPY_CONTEXT, INPUT_SPY_CONTEXT);
  assert.equal(snap.inputsPresent & INPUT_GROWTH_VALUE, INPUT_GROWTH_VALUE);
  assert.equal(snap.inputsPresent & INPUT_Z_BASELINES, INPUT_Z_BASELINES);
});

test('inputsPresent matches actual present-input set on sparse snapshot', () => {
  // No SPY context, no growth/value, no z baselines → only bits 0/1/2 should be set.
  const snap = computeSectorRotation(baseInputs({
    spyClose: null, spy52wHigh: null,
    iwfReturn20d: null, iwdReturn20d: null,
    defensiveCyclicalSpreadZScore: null,
    topSectorVolumeShareZScore: null,
  }));
  assert.equal(snap.inputsPresent,
    INPUT_DEFENSIVE_RETURNS | INPUT_CYCLICAL_RETURNS | INPUT_SECTOR_VOLUMES);
});

// ───── Composite version pin ───────────────────────────────────────────

test('compositeVersion is pinned to sector_rot_v1', () => {
  const snap = computeSectorRotation(baseInputs());
  assert.equal(snap.compositeVersion, 'sector_rot_v1');
  assert.equal(SECTOR_ROT_COMPOSITE_VERSION, 'sector_rot_v1');
});

// ───── Constants & threshold pins ──────────────────────────────────────

test('threshold constants match SPEC §2', () => {
  assert.equal(DEFENSIVE_LEAD_Z_THRESHOLD, 1.0);
  assert.equal(CONCENTRATION_EXTREME_Z_THRESHOLD, 1.5);
  assert.equal(SPY_HIGH_PROXIMITY_THRESHOLD, 0.05);
});

test('basket membership matches SPEC §2', () => {
  assert.deepEqual([...DEFENSIVE_SECTORS], ['XLP', 'XLU', 'XLV']);
  assert.deepEqual([...CYCLICAL_SECTORS], ['XLY', 'XLK', 'XLF']);
  assert.deepEqual([...TRACKED_SECTORS], [
    'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP',
    'XLU', 'XLI', 'XLB', 'XLRE', 'XLC',
  ]);
});
