/**
 * Tests for src/server/fee_model.ts.
 *
 * SPEC: docs/specs/live-trade-broker-integration.md §6 Phase A test list.
 *
 * Contract pinned here:
 *   - buys are commission-only ($0 for Alpaca equities); no SEC or TAF.
 *   - sells incur SEC (per-notional) + TAF (per-share, capped) + commission.
 *   - 'paper' venue uses the same schedule as 'alpaca' (fee symmetry).
 *   - Unknown venues throw loudly (no silent fall-through to equity math).
 *   - Non-positive notional / shares throw.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPACA_EQUITY_FEE_SCHEDULE,
  quoteFees,
} from '../../src/server/fee_model.js';

describe('quoteFees — buy side (commission only on equities)', () => {
  it('Alpaca buy returns zero fees across all components', () => {
    const q = quoteFees({ venue: 'alpaca', side: 'buy', notionalUsd: 10_000, shares: 100 });
    assert.equal(q.feeUsd, 0);
    assert.equal(q.perShareUsd, 0);
    assert.equal(q.regulatoryFeeUsd, 0);
    assert.equal(q.brokerCommissionUsd, 0);
  });

  it('paper buy is fee-symmetric with Alpaca buy', () => {
    const alpaca = quoteFees({ venue: 'alpaca', side: 'buy', notionalUsd: 5_000, shares: 50 });
    const paper = quoteFees({ venue: 'paper', side: 'buy', notionalUsd: 5_000, shares: 50 });
    assert.deepEqual(paper, alpaca);
  });
});

describe('quoteFees — sell side (SEC + TAF + commission)', () => {
  it('Alpaca sell at notional below TAF cap', () => {
    // 100 shares × $100 = $10,000 notional. TAF = 100 × 0.000119 = $0.0119; well under cap.
    const q = quoteFees({ venue: 'alpaca', side: 'sell', notionalUsd: 10_000, shares: 100 });
    assert.equal(
      q.regulatoryFeeUsd,
      10_000 * ALPACA_EQUITY_FEE_SCHEDULE.secFeeRatePerNotional,
      'SEC fee should equal notional × per-notional rate',
    );
    assert.equal(
      q.perShareUsd,
      100 * ALPACA_EQUITY_FEE_SCHEDULE.tafRatePerShare,
      'TAF should equal shares × per-share rate (uncapped at this size)',
    );
    assert.equal(q.brokerCommissionUsd, 0);
    assert.equal(q.feeUsd, q.regulatoryFeeUsd + q.perShareUsd + q.brokerCommissionUsd);
  });

  it('TAF clamps at the per-trade cap on very large share counts', () => {
    // 100,000 shares × 0.000119 = $11.90 uncapped → clamps to $7.27.
    const q = quoteFees({ venue: 'alpaca', side: 'sell', notionalUsd: 100_000, shares: 100_000 });
    assert.equal(
      q.perShareUsd,
      ALPACA_EQUITY_FEE_SCHEDULE.tafCapUsdPerTrade,
      'TAF must clamp at the cap when uncapped value would exceed it',
    );
  });

  it('SEC fee scales linearly with notional', () => {
    const small = quoteFees({ venue: 'alpaca', side: 'sell', notionalUsd: 1_000, shares: 10 });
    const big = quoteFees({ venue: 'alpaca', side: 'sell', notionalUsd: 10_000, shares: 10 });
    // 10x notional → 10x SEC fee. Use approx-equal for FP.
    assert.ok(
      Math.abs(big.regulatoryFeeUsd / small.regulatoryFeeUsd - 10) < 1e-9,
      `SEC fee should scale 10x; got ${big.regulatoryFeeUsd / small.regulatoryFeeUsd}`,
    );
  });

  it('paper sell is fee-symmetric with Alpaca sell', () => {
    const alpaca = quoteFees({ venue: 'alpaca', side: 'sell', notionalUsd: 25_000, shares: 250 });
    const paper = quoteFees({ venue: 'paper', side: 'sell', notionalUsd: 25_000, shares: 250 });
    assert.deepEqual(paper, alpaca);
  });
});

describe('quoteFees — input validation (loud-fail per SPEC §3)', () => {
  it('throws on unsupported venue (crypto stub)', () => {
    assert.throws(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => quoteFees({ venue: 'kraken' as any, side: 'buy', notionalUsd: 1000, shares: 10 }),
      /venue 'kraken' is not equity-supported/,
      'unknown venues must throw, not silently fall through',
    );
  });

  it('throws on zero notional', () => {
    assert.throws(
      () => quoteFees({ venue: 'alpaca', side: 'buy', notionalUsd: 0, shares: 10 }),
      /notionalUsd must be a positive finite number/,
    );
  });

  it('throws on negative notional', () => {
    assert.throws(
      () => quoteFees({ venue: 'alpaca', side: 'sell', notionalUsd: -100, shares: 10 }),
      /notionalUsd must be a positive finite number/,
    );
  });

  it('throws on NaN notional', () => {
    assert.throws(
      () => quoteFees({ venue: 'alpaca', side: 'buy', notionalUsd: NaN, shares: 10 }),
      /notionalUsd must be a positive finite number/,
    );
  });

  it('throws on zero shares', () => {
    assert.throws(
      () => quoteFees({ venue: 'alpaca', side: 'sell', notionalUsd: 1000, shares: 0 }),
      /shares must be a positive finite number/,
    );
  });

  it('throws on negative shares', () => {
    assert.throws(
      () => quoteFees({ venue: 'alpaca', side: 'sell', notionalUsd: 1000, shares: -5 }),
      /shares must be a positive finite number/,
    );
  });
});

describe('ALPACA_EQUITY_FEE_SCHEDULE — values pinned for review', () => {
  it('SEC fee rate matches the 2026-05 documented value', () => {
    // SPEC §7 item 2 — re-verify annually. Test pinning catches accidental edits.
    assert.equal(ALPACA_EQUITY_FEE_SCHEDULE.secFeeRatePerNotional, 0.0000278);
  });

  it('TAF rate and cap match the 2026-05 documented values', () => {
    assert.equal(ALPACA_EQUITY_FEE_SCHEDULE.tafRatePerShare, 0.000119);
    assert.equal(ALPACA_EQUITY_FEE_SCHEDULE.tafCapUsdPerTrade, 7.27);
  });

  it('Alpaca equity commission is $0', () => {
    assert.equal(ALPACA_EQUITY_FEE_SCHEDULE.brokerCommissionUsd, 0);
  });
});
