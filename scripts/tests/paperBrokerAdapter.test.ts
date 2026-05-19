/**
 * Tests for src/server/brokers/paper.ts.
 *
 * SPEC: docs/specs/live-trade-broker-integration.md §6 Phase A test list
 * (paperBrokerAdapter ~6 tests; idempotency + synthetic fill + limit
 * crossing semantics + input validation).
 *
 * Contract pinned here:
 *   - Market orders fill at the priceProvider's value.
 *   - Limit orders fill at the limit price iff they cross favorably;
 *     otherwise stay 'pending' (no synthetic fill).
 *   - Identical clientOrderId on a retry returns the SAME handle (no
 *     double fill). SPEC §7 item 3.
 *   - Fees come from fee_model.ts (paper venue is fee-symmetric with
 *     alpaca venue per SPEC §3.1).
 *   - Input validation: limit needs limitPrice; market rejects limitPrice;
 *     non-positive qty throws.
 *   - Unknown brokerOrderId on getOrderStatus → 'rejected' (not throw).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PaperBrokerAdapter } from '../../src/server/brokers/paper.js';
import type { PlaceOrderInput } from '../../src/server/brokers/types.js';
import { quoteFees } from '../../src/server/fee_model.js';

function makeAdapter(priceProvider?: (s: string) => number) {
  return new PaperBrokerAdapter({
    priceProvider: priceProvider ?? ((_s: string) => 100),
  });
}

function makeInput(overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput {
  return {
    symbol: 'SPY',
    side: 'buy',
    orderType: 'market',
    qty: 10,
    clientOrderId: `cid-${Math.random().toString(36).slice(2)}`,
    timeInForce: 'day',
    ...overrides,
  };
}

describe('PaperBrokerAdapter.placeOrder — market orders', () => {
  it('fills at the priceProvider value for market BUY', async () => {
    const adapter = makeAdapter(() => 123.45);
    const handle = await adapter.placeOrder(makeInput({ side: 'buy', qty: 10 }));
    const status = await adapter.getOrderStatus(handle);
    assert.equal(status.status, 'filled');
    assert.equal(status.filledQty, 10);
    assert.equal(status.avgFillPrice, 123.45);
  });

  it('fills at the priceProvider value for market SELL and charges fees', async () => {
    const adapter = makeAdapter(() => 200);
    const input = makeInput({ side: 'sell', qty: 50 });
    const handle = await adapter.placeOrder(input);
    const status = await adapter.getOrderStatus(handle);
    const expectedFees = quoteFees({
      venue: 'paper',
      side: 'sell',
      notionalUsd: 200 * 50,
      shares: 50,
    }).feeUsd;
    assert.equal(status.feesUsd, expectedFees);
    assert.ok(status.feesUsd > 0, 'sell side must charge non-zero fees');
  });

  it('rejects a market order that carries a limitPrice (loud-fail)', async () => {
    const adapter = makeAdapter();
    await assert.rejects(
      () => adapter.placeOrder(makeInput({ orderType: 'market', limitPrice: 100 })),
      /market order must not carry a limitPrice/,
    );
  });
});

describe('PaperBrokerAdapter.placeOrder — limit orders', () => {
  it('limit BUY fills at limit when market crosses favorably (market <= limit)', async () => {
    const adapter = makeAdapter(() => 98); // market favorable for buyer
    const handle = await adapter.placeOrder(makeInput({
      orderType: 'limit', limitPrice: 100, side: 'buy',
    }));
    const status = await adapter.getOrderStatus(handle);
    assert.equal(status.status, 'filled');
    assert.equal(status.avgFillPrice, 100, 'conservative-fill rule: paper fills AT limit, not at market');
  });

  it('limit BUY stays pending when market is above limit', async () => {
    const adapter = makeAdapter(() => 102); // market above buy limit
    const handle = await adapter.placeOrder(makeInput({
      orderType: 'limit', limitPrice: 100, side: 'buy',
    }));
    const status = await adapter.getOrderStatus(handle);
    assert.equal(status.status, 'pending');
    assert.equal(status.filledQty, 0);
    assert.equal(status.avgFillPrice, null);
  });

  it('limit SELL fills at limit when market crosses favorably (market >= limit)', async () => {
    const adapter = makeAdapter(() => 105);
    const handle = await adapter.placeOrder(makeInput({
      orderType: 'limit', limitPrice: 100, side: 'sell',
    }));
    const status = await adapter.getOrderStatus(handle);
    assert.equal(status.status, 'filled');
    assert.equal(status.avgFillPrice, 100);
  });

  it('limit SELL stays pending when market is below limit', async () => {
    const adapter = makeAdapter(() => 95);
    const handle = await adapter.placeOrder(makeInput({
      orderType: 'limit', limitPrice: 100, side: 'sell',
    }));
    const status = await adapter.getOrderStatus(handle);
    assert.equal(status.status, 'pending');
  });

  it('rejects a limit order with no limitPrice', async () => {
    const adapter = makeAdapter();
    await assert.rejects(
      () => adapter.placeOrder(makeInput({ orderType: 'limit', limitPrice: undefined })),
      /limit order requires limitPrice/,
    );
  });
});

describe('PaperBrokerAdapter.placeOrder — idempotency contract (SPEC §7 item 3)', () => {
  it('retry on the same clientOrderId returns the SAME handle and does not double-fill', async () => {
    const adapter = makeAdapter(() => 100);
    const input = makeInput({ clientOrderId: 'dedupe-me', qty: 10 });
    const handle1 = await adapter.placeOrder(input);
    const handle2 = await adapter.placeOrder(input);
    assert.equal(handle1.brokerOrderId, handle2.brokerOrderId,
      'same clientOrderId must return same brokerOrderId — load-bearing for live correctness');
    const status = await adapter.getOrderStatus(handle1);
    assert.equal(status.filledQty, 10, 'qty must be the SINGLE order qty, not 2x');
  });

  it('different clientOrderIds produce different handles', async () => {
    const adapter = makeAdapter(() => 100);
    const h1 = await adapter.placeOrder(makeInput({ clientOrderId: 'cid-1' }));
    const h2 = await adapter.placeOrder(makeInput({ clientOrderId: 'cid-2' }));
    assert.notEqual(h1.brokerOrderId, h2.brokerOrderId);
  });
});

describe('PaperBrokerAdapter — input validation', () => {
  it('throws on zero qty', async () => {
    const adapter = makeAdapter();
    await assert.rejects(
      () => adapter.placeOrder(makeInput({ qty: 0 })),
      /qty must be a positive finite number/,
    );
  });

  it('throws on negative qty', async () => {
    const adapter = makeAdapter();
    await assert.rejects(
      () => adapter.placeOrder(makeInput({ qty: -5 })),
      /qty must be a positive finite number/,
    );
  });
});

describe('PaperBrokerAdapter.cancelOrder', () => {
  it('cancels a pending limit order', async () => {
    const adapter = makeAdapter(() => 102);
    const handle = await adapter.placeOrder(makeInput({
      orderType: 'limit', limitPrice: 100, side: 'buy',
    }));
    let status = await adapter.getOrderStatus(handle);
    assert.equal(status.status, 'pending');
    await adapter.cancelOrder(handle);
    status = await adapter.getOrderStatus(handle);
    assert.equal(status.status, 'canceled');
  });

  it('is a no-op on terminal-filled orders (does not "unfill")', async () => {
    const adapter = makeAdapter(() => 100);
    const handle = await adapter.placeOrder(makeInput());
    let status = await adapter.getOrderStatus(handle);
    assert.equal(status.status, 'filled');
    await adapter.cancelOrder(handle);
    status = await adapter.getOrderStatus(handle);
    assert.equal(status.status, 'filled', 'terminal status must NOT be reversed by cancel');
  });

  it('is a no-op on unknown brokerOrderId', async () => {
    const adapter = makeAdapter();
    await adapter.cancelOrder({
      brokerOrderId: 'paper-bogus',
      venue: 'paper',
      clientOrderId: 'unknown',
      placedAt: new Date(),
    });
    // Just shouldn't throw.
  });
});

describe('PaperBrokerAdapter.getOrderStatus — unknown handle', () => {
  it('returns "rejected" (not throw) on unknown brokerOrderId — matches real-broker idiom', async () => {
    const adapter = makeAdapter();
    const status = await adapter.getOrderStatus({
      brokerOrderId: 'paper-not-real',
      venue: 'paper',
      clientOrderId: 'x',
      placedAt: new Date(),
    });
    assert.equal(status.status, 'rejected');
    assert.match(status.rejectionReason ?? '', /no order with brokerOrderId=paper-not-real/);
  });
});

describe('PaperBrokerAdapter.getAccount / getPositions', () => {
  it('getAccount returns the default snapshot when none provided', async () => {
    const adapter = makeAdapter();
    const acct = await adapter.getAccount();
    assert.equal(acct.equityUsd, 100_000);
    assert.equal(acct.cashUsd, 100_000);
    assert.equal(acct.patternDayTrader, false);
  });

  it('getAccount returns an injected snapshot when provided', async () => {
    const adapter = new PaperBrokerAdapter({
      priceProvider: () => 100,
      accountSnapshot: { equityUsd: 5_000, cashUsd: 4_000, patternDayTrader: true },
    });
    const acct = await adapter.getAccount();
    assert.equal(acct.equityUsd, 5_000);
    assert.equal(acct.patternDayTrader, true);
  });

  it('getPositions returns [] (paper adapter does not journal positions)', async () => {
    const adapter = makeAdapter();
    await adapter.placeOrder(makeInput());
    const positions = await adapter.getPositions();
    assert.deepEqual(positions, []);
  });
});
