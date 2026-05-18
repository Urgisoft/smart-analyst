/**
 * SPEC §1 — input parsing/validation for POST /api/validator/score.
 * The reject conditions and accept-with-degrade conditions in the spec are pinned here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseValidatorRequest,
  MIN_BARS_PER_TRIAL,
  MIN_BARS_PER_SPLIT_SIDE,
} from '../../src/lib/validator_request.js';

// ───── Fixture builders ─────
function makeTrialReturns(opts: {
  trialIds: string[];
  nBars: number;
  baseTs?: number;
  intervalSec?: number;
  retGen?: (trialIdx: number, barIdx: number) => number;
}) {
  const { trialIds, nBars, baseTs = 1_700_000_000, intervalSec = 86_400 } = opts;
  const retGen = opts.retGen ?? (() => 0.001);
  const rows: { trialId: string; ts: number; ret: number }[] = [];
  for (let t = 0; t < trialIds.length; t++) {
    for (let i = 0; i < nBars; i++) {
      rows.push({ trialId: trialIds[t], ts: baseTs + i * intervalSec, ret: retGen(t, i) });
    }
  }
  return rows;
}

function validRequest() {
  const trialReturns = makeTrialReturns({ trialIds: ['a', 'b', 'c'], nBars: 100 });
  return {
    trialReturns,
    chosenTrialId: 'a',
    isOosSplitTs: 1_700_000_000 + 50 * 86_400, // mid-range
  };
}

// ───── Happy path ─────
describe('parseValidatorRequest — minimal valid', () => {
  it('accepts a 3-trial × 100-bar request with mid-range split', () => {
    const r = parseValidatorRequest(validRequest());
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.trialReturns.length, 300);
      assert.equal(r.value.chosenTrialId, 'a');
    }
  });

  it('round-trip: parse → JSON.stringify → parse produces identical structure', () => {
    const original = validRequest();
    const r1 = parseValidatorRequest(original);
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    const r2 = parseValidatorRequest(JSON.parse(JSON.stringify(r1.value)));
    assert.equal(r2.ok, true);
    if (!r2.ok) return;
    assert.equal(r2.value.trialReturns.length, r1.value.trialReturns.length);
    assert.equal(r2.value.chosenTrialId, r1.value.chosenTrialId);
    assert.equal(r2.value.isOosSplitTs, r1.value.isOosSplitTs);
  });
});

// ───── Body-shape rejections ─────
describe('parseValidatorRequest — body shape', () => {
  it('rejects null / non-object body', () => {
    for (const b of [null, 'string', 42, [1, 2, 3]]) {
      const r = parseValidatorRequest(b);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error, 'malformed_body');
    }
  });

  it('rejects missing trialReturns', () => {
    const r = parseValidatorRequest({ chosenTrialId: 'a', isOosSplitTs: 1_700_000_000 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'trial_returns_missing');
  });

  it('rejects missing chosenTrialId', () => {
    const r = parseValidatorRequest({ trialReturns: [], isOosSplitTs: 1_700_000_000 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'chosen_trial_id_missing');
  });

  it('rejects non-finite isOosSplitTs', () => {
    const v = validRequest();
    const r = parseValidatorRequest({ ...v, isOosSplitTs: NaN });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'split_ts_missing');
  });

  it('rejects malformed trial row (missing field)', () => {
    const v = validRequest();
    const bad = [...v.trialReturns];
    bad[5] = { trialId: 'a', ts: 123 } as never; // missing ret
    const r = parseValidatorRequest({ ...v, trialReturns: bad });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'trial_row_malformed');
  });

  it('rejects malformed trial row (NaN ret)', () => {
    const v = validRequest();
    const bad = [...v.trialReturns];
    bad[5] = { trialId: 'a', ts: 1_700_000_000, ret: NaN };
    const r = parseValidatorRequest({ ...v, trialReturns: bad });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'trial_row_malformed');
  });
});

// ───── Trial-set rejections ─────
describe('parseValidatorRequest — trial set', () => {
  it('rejects when chosenTrialId is not present in trialReturns', () => {
    const v = validRequest();
    const r = parseValidatorRequest({ ...v, chosenTrialId: 'nonexistent' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'chosen_trial_id_not_found');
  });

  it('rejects when only 1 distinct trial is present', () => {
    const trialReturns = makeTrialReturns({ trialIds: ['solo'], nBars: 100 });
    const r = parseValidatorRequest({
      trialReturns,
      chosenTrialId: 'solo',
      isOosSplitTs: 1_700_000_000 + 50 * 86_400,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'pbo_requires_multiple_trials');
  });

  it(`rejects when any trial has < ${MIN_BARS_PER_TRIAL} bars`, () => {
    const ok = makeTrialReturns({ trialIds: ['a', 'b'], nBars: 100 });
    const short = makeTrialReturns({
      trialIds: ['c'],
      nBars: MIN_BARS_PER_TRIAL - 1,
      baseTs: 1_700_000_000,
    });
    const r = parseValidatorRequest({
      trialReturns: [...ok, ...short],
      chosenTrialId: 'a',
      isOosSplitTs: 1_700_000_000 + 50 * 86_400,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'trial_too_short');
  });
});

// ───── Alignment rejections ─────
describe('parseValidatorRequest — timestamp alignment', () => {
  it('rejects when one trial has a different bar count', () => {
    const a = makeTrialReturns({ trialIds: ['a'], nBars: 100 });
    const b = makeTrialReturns({ trialIds: ['b'], nBars: 99 });
    const r = parseValidatorRequest({
      trialReturns: [...a, ...b],
      chosenTrialId: 'a',
      isOosSplitTs: 1_700_000_000 + 50 * 86_400,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'trial_timestamps_misaligned');
  });

  it('rejects when bar counts match but timestamps differ', () => {
    const a = makeTrialReturns({ trialIds: ['a'], nBars: 100 });
    const b = makeTrialReturns({ trialIds: ['b'], nBars: 100, baseTs: 1_700_000_000 + 7200 });
    const r = parseValidatorRequest({
      trialReturns: [...a, ...b],
      chosenTrialId: 'a',
      isOosSplitTs: 1_700_000_000 + 50 * 86_400,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'trial_timestamps_misaligned');
  });

  it('accepts non-time-order rows (parser sorts internally)', () => {
    const v = validRequest();
    const shuffled = [...v.trialReturns].reverse();
    const r = parseValidatorRequest({ ...v, trialReturns: shuffled });
    assert.equal(r.ok, true);
  });
});

// ───── IS/OOS split rejections ─────
describe('parseValidatorRequest — IS/OOS split', () => {
  it('rejects split before data start', () => {
    const v = validRequest();
    const r = parseValidatorRequest({ ...v, isOosSplitTs: 1_500_000_000 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'split_outside_data_range');
  });

  it('rejects split after data end', () => {
    const v = validRequest();
    const r = parseValidatorRequest({ ...v, isOosSplitTs: 1_900_000_000 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'split_outside_data_range');
  });

  it(`rejects split leaving < ${MIN_BARS_PER_SPLIT_SIDE} bars on IS side`, () => {
    const v = validRequest();
    const earlySplit = 1_700_000_000 + 5 * 86_400;
    const r = parseValidatorRequest({ ...v, isOosSplitTs: earlySplit });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'split_window_too_small');
  });

  it(`rejects split leaving < ${MIN_BARS_PER_SPLIT_SIDE} bars on OOS side`, () => {
    const v = validRequest();
    const lateSplit = 1_700_000_000 + 95 * 86_400;
    const r = parseValidatorRequest({ ...v, isOosSplitTs: lateSplit });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'split_window_too_small');
  });
});

// ───── Percent-vs-decimal sanity ─────
describe('parseValidatorRequest — percent units guard', () => {
  it('rejects returns that look like percent units (mean |ret| > 0.5)', () => {
    const trialReturns = makeTrialReturns({
      trialIds: ['a', 'b'],
      nBars: 100,
      retGen: () => 1.2, // user pasted 1.2% as 1.2 instead of 0.012
    });
    const r = parseValidatorRequest({
      trialReturns,
      chosenTrialId: 'a',
      isOosSplitTs: 1_700_000_000 + 50 * 86_400,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'returns_likely_in_percent_not_decimal');
  });

  it('accepts proper decimal returns even when occasionally large', () => {
    // Mean abs return = 0.01 — well within decimal-ness.
    const trialReturns = makeTrialReturns({
      trialIds: ['a', 'b'],
      nBars: 100,
      retGen: (_, i) => (i === 50 ? 0.4 : 0.005),
    });
    const r = parseValidatorRequest({
      trialReturns,
      chosenTrialId: 'a',
      isOosSplitTs: 1_700_000_000 + 50 * 86_400,
    });
    assert.equal(r.ok, true);
  });
});

// ───── Optional fields ─────
describe('parseValidatorRequest — optional fields', () => {
  it('accepts request with perAssetSharpes', () => {
    const v = validRequest();
    const r = parseValidatorRequest({
      ...v,
      perAssetSharpes: [
        { assetId: 'BTC', sharpe: 1.2 },
        { assetId: 'ETH', sharpe: 0.8 },
      ],
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.perAssetSharpes?.length, 2);
  });

  it('rejects malformed perAssetSharpes (non-finite sharpe)', () => {
    const v = validRequest();
    const r = parseValidatorRequest({
      ...v,
      perAssetSharpes: [{ assetId: 'BTC', sharpe: Infinity }],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'per_asset_sharpes_malformed');
  });

  it('accepts request with trialTradeCounts', () => {
    const v = validRequest();
    const r = parseValidatorRequest({
      ...v,
      trialTradeCounts: { a: 50, b: 30, c: 12 },
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.trialTradeCounts?.a, 50);
  });

  it('rejects malformed trialTradeCounts (negative)', () => {
    const v = validRequest();
    const r = parseValidatorRequest({
      ...v,
      trialTradeCounts: { a: -1 },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'trade_counts_malformed');
  });

  it('accepts threshold overrides', () => {
    const v = validRequest();
    const r = parseValidatorRequest({
      ...v,
      thresholds: { dsrGate: 0.99, hlzMethod: 'bonferroni' },
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.thresholds?.dsrGate, 0.99);
      assert.equal(r.value.thresholds?.hlzMethod, 'bonferroni');
    }
  });

  it('rejects malformed thresholds (unknown hlzMethod)', () => {
    const v = validRequest();
    const r = parseValidatorRequest({
      ...v,
      thresholds: { hlzMethod: 'fdr' as never },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'thresholds_malformed');
  });
});
