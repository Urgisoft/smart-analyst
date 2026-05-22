/**
 * Tests for src/server/form_4_insider.ts — pure-function composite (Phase A2).
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §§2.3, 5.3, 5.4, 9.7
 *   (T-F4-1..T-F4-14).
 *
 * No CH dependency; in-memory composite tests only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORM_4_INSIDER_COMPOSITE_VERSION,
  ROLLING_WINDOW_DAYS,
  CLUSTER_WINDOW_DAYS,
  CLUSTER_INSIDER_THRESHOLD,
  FORM_4_CLUSTER_Z_THRESHOLD,
  MIN_Z_BASELINE,
  HIGH_SIGNAL_TRANSACTION_CODES,
  BUY_CODE,
  SELL_CODE,
  dedupeTrades,
  filterTradesToHighSignalCodes,
  filterTradesInWindow,
  countTradesByCode,
  sumDollarsByCode,
  computeInsiderNetDollar,
  countDistinctInsidersByCode,
  flagInsiderCluster,
  computeSectorClusterRate,
  computeZ,
  flagForm4Cluster,
  evaluateForm4InsiderComposite,
  type InsiderTrade,
  type Form4InsiderInputs,
} from '../../src/server/form_4_insider.js';

const ASOF = new Date('2026-05-20T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Floating-point-tolerant equality assertion. */
function assertClose(actual: number | null, expected: number, eps = 1e-9): void {
  assert.ok(actual != null, `expected close to ${expected}, got null`);
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected close to ${expected}, got ${actual} (delta ${Math.abs(actual - expected)})`,
  );
}

/** Build a synthetic trade with overrides. Defaults to a code-P insider buy
 *  on AAPL 10 days before ASOF, 100 shares at $150 = $15,000. */
function makeTrade(overrides: Partial<InsiderTrade> = {}): InsiderTrade {
  const shares = overrides.shares ?? 100;
  const pricePerShare = overrides.pricePerShare ?? 150;
  return {
    accession: overrides.accession ?? '0001-26-1',
    transactionId: overrides.transactionId ?? 0,
    issuerCik: overrides.issuerCik ?? '0000320193',
    issuerTicker: overrides.issuerTicker ?? 'AAPL',
    personCik: overrides.personCik ?? '0001000001',
    roleFlags: overrides.roleFlags ?? 0,
    transactionCode: overrides.transactionCode ?? 'P',
    acceptedAt: overrides.acceptedAt ?? new Date(ASOF.getTime() - 10 * DAY_MS),
    shares,
    pricePerShare,
    dollarAmount: overrides.dollarAmount ?? shares * pricePerShare,
  };
}

/** Build composite inputs with overrides. */
function makeInputs(overrides: Partial<Form4InsiderInputs> = {}): Form4InsiderInputs {
  return {
    asOf: ASOF,
    lastEdgarQueryAt: new Date('2026-05-20T11:00:00Z'),
    bdSinceLastQuery: 0,
    perTicker: [],
    sectors: [],
    ...overrides,
  };
}

// ── T-F4-1: insider_buy_count_90d counts only code "P" in window ────────────

describe('insider_buy_count_90d counts P only (T-F4-1)', () => {
  it('counts exactly 1 P trade', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [makeTrade({ transactionCode: 'P' })],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderBuyCount90d, 1);
    assert.equal(snap.perTickerRows[0].insiderSellCount90d, 0);
  });

  it('excludes S code from buy count', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'A', transactionCode: 'P' }),
          makeTrade({ accession: 'B', transactionCode: 'S' }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderBuyCount90d, 1);
    assert.equal(snap.perTickerRows[0].insiderSellCount90d, 1);
  });

  it('countTradesByCode helper matches by exact code', () => {
    const trades = [
      makeTrade({ accession: 'A', transactionCode: 'P' }),
      makeTrade({ accession: 'B', transactionCode: 'P' }),
      makeTrade({ accession: 'C', transactionCode: 'S' }),
    ];
    assert.equal(countTradesByCode(trades, 'P', ASOF), 2);
    assert.equal(countTradesByCode(trades, 'S', ASOF), 1);
  });
});

// ── T-F4-2: insider_sell_count_90d counts only code "S" in window ───────────

describe('insider_sell_count_90d counts S only (T-F4-2)', () => {
  it('mirrors T-F4-1 for sell side', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'A', transactionCode: 'S' }),
          makeTrade({ accession: 'B', transactionCode: 'S' }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderSellCount90d, 2);
    assert.equal(snap.perTickerRows[0].insiderBuyCount90d, 0);
  });
});

// ── T-F4-3: other transaction codes excluded from composite ─────────────────

describe('other codes excluded (T-F4-3)', () => {
  it('A (grant), M (exercise), F (payment), G (gift) are filtered out', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'A' }),  // grant
          makeTrade({ accession: 'b', transactionCode: 'M' }),  // exercise
          makeTrade({ accession: 'c', transactionCode: 'F' }),  // tax payment
          makeTrade({ accession: 'd', transactionCode: 'G' }),  // gift
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.insiderBuyCount90d, 0);
    assert.equal(row.insiderSellCount90d, 0);
    assert.equal(row.insiderNetDollar90d, 0);
    assert.equal(row.insiderBuyerCount90d, 0);
    assert.equal(row.insiderSellerCount90d, 0);
    assert.equal(row.insiderClusterBuyFlag, false);
    assert.equal(row.insiderClusterSellFlag, false);
  });

  it('mixed in-set + off-set: in-set counts, off-set ignored', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P' }),
          makeTrade({ accession: 'b', transactionCode: 'A' }),  // grant — off-set
          makeTrade({ accession: 'c', transactionCode: 'M' }),  // exercise — off-set
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderBuyCount90d, 1);
  });

  it('filterTradesToHighSignalCodes helper retains only {P, S}', () => {
    const trades = [
      makeTrade({ accession: 'a', transactionCode: 'P' }),
      makeTrade({ accession: 'b', transactionCode: 'S' }),
      makeTrade({ accession: 'c', transactionCode: 'A' }),
      makeTrade({ accession: 'd', transactionCode: 'M' }),
      makeTrade({ accession: 'e', transactionCode: '' }),
    ];
    const filtered = filterTradesToHighSignalCodes(trades);
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every((t) => t.transactionCode === 'P' || t.transactionCode === 'S'));
  });
});

// ── T-F4-4: insider_net_dollar_90d = Σ(buy $) − Σ(sell $) ────────────────────

describe('insider_net_dollar_90d (T-F4-4)', () => {
  it('positive net for net-buying ticker', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', dollarAmount: 100_000 }),
          makeTrade({ accession: 'b', transactionCode: 'P', dollarAmount: 50_000 }),
          makeTrade({ accession: 'c', transactionCode: 'S', dollarAmount: 20_000 }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assertClose(snap.perTickerRows[0].insiderNetDollar90d, 130_000);
  });

  it('negative net for net-selling ticker', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', dollarAmount: 30_000 }),
          makeTrade({ accession: 'b', transactionCode: 'S', dollarAmount: 80_000 }),
          makeTrade({ accession: 'c', transactionCode: 'S', dollarAmount: 100_000 }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assertClose(snap.perTickerRows[0].insiderNetDollar90d, -150_000);
  });

  it('zero net when buys equal sells', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', dollarAmount: 50_000 }),
          makeTrade({ accession: 'b', transactionCode: 'S', dollarAmount: 50_000 }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assertClose(snap.perTickerRows[0].insiderNetDollar90d, 0);
  });

  it('excludes off-set codes from dollar math', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', dollarAmount: 100_000 }),
          // Massive grant would skew net if not filtered out:
          makeTrade({ accession: 'b', transactionCode: 'A', dollarAmount: 1_000_000 }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assertClose(snap.perTickerRows[0].insiderNetDollar90d, 100_000);
  });

  it('sumDollarsByCode helper sums correctly per direction', () => {
    const trades = [
      makeTrade({ accession: 'a', transactionCode: 'P', dollarAmount: 50_000 }),
      makeTrade({ accession: 'b', transactionCode: 'P', dollarAmount: 30_000 }),
      makeTrade({ accession: 'c', transactionCode: 'S', dollarAmount: 70_000 }),
    ];
    assertClose(sumDollarsByCode(trades, 'P', ASOF), 80_000);
    assertClose(sumDollarsByCode(trades, 'S', ASOF), 70_000);
  });

  it('computeInsiderNetDollar helper matches subtraction', () => {
    const trades = [
      makeTrade({ accession: 'a', transactionCode: 'P', dollarAmount: 100 }),
      makeTrade({ accession: 'b', transactionCode: 'S', dollarAmount: 40 }),
    ];
    assertClose(computeInsiderNetDollar(trades, ASOF), 60);
  });
});

// ── T-F4-5: insider_buyer_count_90d = distinct person_cik in window buys ────

describe('insider_buyer_count_90d distinct person_cik (T-F4-5)', () => {
  it('3 distinct insider buys → buyer count = 3', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', personCik: '0001000001' }),
          makeTrade({ accession: 'b', transactionCode: 'P', personCik: '0001000002' }),
          makeTrade({ accession: 'c', transactionCode: 'P', personCik: '0001000003' }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderBuyerCount90d, 3);
    assert.equal(snap.perTickerRows[0].insiderBuyCount90d, 3);
  });

  it('1 insider with 3 buys → buyer count = 1, buy count = 3', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', personCik: '0001000001' }),
          makeTrade({ accession: 'b', transactionCode: 'P', personCik: '0001000001' }),
          makeTrade({ accession: 'c', transactionCode: 'P', personCik: '0001000001' }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderBuyerCount90d, 1);
    assert.equal(snap.perTickerRows[0].insiderBuyCount90d, 3);
  });

  it('insider_seller_count_90d mirrors the buyer logic', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'S', personCik: '0001000001' }),
          makeTrade({ accession: 'b', transactionCode: 'S', personCik: '0001000002' }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderSellerCount90d, 2);
  });

  it('countDistinctInsidersByCode handles same person across codes correctly', () => {
    // One insider files both a P and an S. Distinct buyer count on code P
    // should be 1; distinct seller count on code S should also be 1.
    const trades = [
      makeTrade({ accession: 'a', transactionCode: 'P', personCik: '0001000001' }),
      makeTrade({ accession: 'b', transactionCode: 'S', personCik: '0001000001' }),
    ];
    assert.equal(countDistinctInsidersByCode(trades, 'P', ASOF, ROLLING_WINDOW_DAYS), 1);
    assert.equal(countDistinctInsidersByCode(trades, 'S', ASOF, ROLLING_WINDOW_DAYS), 1);
  });
});

// ── T-F4-6: insider_cluster_buy_flag fires on 3 distinct insiders in 30d ────

describe('insider_cluster_buy_flag fires on threshold (T-F4-6)', () => {
  it('fires when exactly 3 distinct insiders buy in trailing 30d', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', personCik: '0001000001',
            acceptedAt: new Date(ASOF.getTime() - 5 * DAY_MS) }),
          makeTrade({ accession: 'b', transactionCode: 'P', personCik: '0001000002',
            acceptedAt: new Date(ASOF.getTime() - 10 * DAY_MS) }),
          makeTrade({ accession: 'c', transactionCode: 'P', personCik: '0001000003',
            acceptedAt: new Date(ASOF.getTime() - 20 * DAY_MS) }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderClusterBuyFlag, true);
  });

  it('fires when 4 distinct insiders buy (above threshold)', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', personCik: '0001000001' }),
          makeTrade({ accession: 'b', transactionCode: 'P', personCik: '0001000002' }),
          makeTrade({ accession: 'c', transactionCode: 'P', personCik: '0001000003' }),
          makeTrade({ accession: 'd', transactionCode: 'P', personCik: '0001000004' }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderClusterBuyFlag, true);
  });
});

// ── T-F4-7: cluster flag does NOT fire on 2 distinct insiders ───────────────

describe('cluster flag does not fire below threshold (T-F4-7)', () => {
  it('2 distinct insiders → no cluster flag', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', personCik: '0001000001' }),
          makeTrade({ accession: 'b', transactionCode: 'P', personCik: '0001000002' }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderClusterBuyFlag, false);
  });

  it('flagInsiderCluster helper: returns true for >= 3, false otherwise', () => {
    assert.equal(flagInsiderCluster(0), false);
    assert.equal(flagInsiderCluster(1), false);
    assert.equal(flagInsiderCluster(2), false);
    assert.equal(flagInsiderCluster(3), true);
    assert.equal(flagInsiderCluster(4), true);
    assert.equal(flagInsiderCluster(99), true);
  });
});

// ── T-F4-8: 1 insider × 3 trades does NOT fire (distinct on person_cik) ─────

describe('cluster flag distinct on person_cik (T-F4-8)', () => {
  it('1 insider filing 3 separate buys does NOT fire cluster', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', personCik: '0001000001',
            acceptedAt: new Date(ASOF.getTime() - 5 * DAY_MS) }),
          makeTrade({ accession: 'b', transactionCode: 'P', personCik: '0001000001',
            acceptedAt: new Date(ASOF.getTime() - 10 * DAY_MS) }),
          makeTrade({ accession: 'c', transactionCode: 'P', personCik: '0001000001',
            acceptedAt: new Date(ASOF.getTime() - 20 * DAY_MS) }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    // 1 distinct insider, 3 trades — buy count = 3 but cluster flag = false.
    assert.equal(snap.perTickerRows[0].insiderBuyCount90d, 3);
    assert.equal(snap.perTickerRows[0].insiderBuyerCount90d, 1);
    assert.equal(snap.perTickerRows[0].insiderClusterBuyFlag, false);
  });
});

// ── T-F4-9: insider_cluster_sell_flag mirror-test ───────────────────────────

describe('insider_cluster_sell_flag fires (T-F4-9)', () => {
  it('3 distinct insiders sell in 30d → sell-cluster fires', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'S', personCik: '0001000001' }),
          makeTrade({ accession: 'b', transactionCode: 'S', personCik: '0001000002' }),
          makeTrade({ accession: 'c', transactionCode: 'S', personCik: '0001000003' }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderClusterSellFlag, true);
    assert.equal(snap.perTickerRows[0].insiderClusterBuyFlag, false);
  });

  it('mixed 2-buy-1-sell does NOT fire either cluster flag (same-direction lock)', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', personCik: '0001000001' }),
          makeTrade({ accession: 'b', transactionCode: 'P', personCik: '0001000002' }),
          makeTrade({ accession: 'c', transactionCode: 'S', personCik: '0001000003' }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderClusterBuyFlag, false);
    assert.equal(snap.perTickerRows[0].insiderClusterSellFlag, false);
  });
});

// ── T-F4-10: 30d window boundary inclusion (cluster window) ─────────────────

describe('cluster window boundary (T-F4-10)', () => {
  it('trade at exactly asOf - 30d 00:00:00 IS in cluster window', () => {
    const t = makeTrade({
      transactionCode: 'P',
      acceptedAt: new Date(ASOF.getTime() - CLUSTER_WINDOW_DAYS * DAY_MS),
    });
    const filtered = filterTradesInWindow([t], ASOF, CLUSTER_WINDOW_DAYS);
    assert.equal(filtered.length, 1);
  });

  it('trade 1 ms before asOf - 30d is NOT in cluster window', () => {
    const t = makeTrade({
      transactionCode: 'P',
      acceptedAt: new Date(ASOF.getTime() - CLUSTER_WINDOW_DAYS * DAY_MS - 1),
    });
    const filtered = filterTradesInWindow([t], ASOF, CLUSTER_WINDOW_DAYS);
    assert.equal(filtered.length, 0);
  });

  it('cluster fires when 3rd insider trades exactly at -30d boundary', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', personCik: '0001000001',
            acceptedAt: new Date(ASOF.getTime() - 5 * DAY_MS) }),
          makeTrade({ accession: 'b', transactionCode: 'P', personCik: '0001000002',
            acceptedAt: new Date(ASOF.getTime() - 15 * DAY_MS) }),
          // exactly at boundary:
          makeTrade({ accession: 'c', transactionCode: 'P', personCik: '0001000003',
            acceptedAt: new Date(ASOF.getTime() - CLUSTER_WINDOW_DAYS * DAY_MS) }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderClusterBuyFlag, true);
  });

  it('cluster does NOT fire when 3rd insider trades 1ms before -30d', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', personCik: '0001000001',
            acceptedAt: new Date(ASOF.getTime() - 5 * DAY_MS) }),
          makeTrade({ accession: 'b', transactionCode: 'P', personCik: '0001000002',
            acceptedAt: new Date(ASOF.getTime() - 15 * DAY_MS) }),
          // 1ms outside cluster window — still counts toward 90d buy count
          // but not toward the cluster threshold.
          makeTrade({ accession: 'c', transactionCode: 'P', personCik: '0001000003',
            acceptedAt: new Date(ASOF.getTime() - CLUSTER_WINDOW_DAYS * DAY_MS - 1) }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderClusterBuyFlag, false);
    assert.equal(snap.perTickerRows[0].insiderBuyCount90d, 3);
  });
});

// ── 90d window boundary (supplemental) ──────────────────────────────────────

describe('90d window boundary (supplemental)', () => {
  it('trade at exactly asOf - 90d 00:00:00 IS in window', () => {
    const t = makeTrade({
      transactionCode: 'P',
      acceptedAt: new Date(ASOF.getTime() - ROLLING_WINDOW_DAYS * DAY_MS),
    });
    const filtered = filterTradesInWindow([t], ASOF, ROLLING_WINDOW_DAYS);
    assert.equal(filtered.length, 1);
  });

  it('trade 91d before asOf is NOT in 90d window (buy count 0)', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [makeTrade({
          transactionCode: 'P',
          acceptedAt: new Date(ASOF.getTime() - 91 * DAY_MS),
        })],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderBuyCount90d, 0);
    assert.equal(snap.perTickerRows[0].insiderNetDollar90d, 0);
  });

  it('trade at exactly asOf IS in window', () => {
    const t = makeTrade({ transactionCode: 'P', acceptedAt: ASOF });
    const filtered = filterTradesInWindow([t], ASOF, ROLLING_WINDOW_DAYS);
    assert.equal(filtered.length, 1);
  });

  it('trade 1ms after asOf is NOT in window (defensive — F4-10 normally upstream)', () => {
    const t = makeTrade({
      transactionCode: 'P',
      acceptedAt: new Date(ASOF.getTime() + 1),
    });
    const filtered = filterTradesInWindow([t], ASOF, ROLLING_WINDOW_DAYS);
    assert.equal(filtered.length, 0);
  });
});

// ── T-F4-11: aggregate sector cluster-rate ──────────────────────────────────

describe('computeSectorClusterRate (T-F4-11)', () => {
  it('2 tickers with cluster-buy in sector of 20 → rate = 0.1', () => {
    const sectorTrades: InsiderTrade[] = [];
    // Ticker AAA — 3 distinct buyers (cluster fires)
    for (let i = 0; i < 3; i++) {
      sectorTrades.push(makeTrade({
        issuerTicker: 'AAA', accession: `a${i}`, transactionCode: 'P',
        personCik: `000100000${i}`,
        acceptedAt: new Date(ASOF.getTime() - (5 + i * 2) * DAY_MS),
      }));
    }
    // Ticker BBB — 3 distinct buyers (cluster fires)
    for (let i = 0; i < 3; i++) {
      sectorTrades.push(makeTrade({
        issuerTicker: 'BBB', accession: `b${i}`, transactionCode: 'P',
        personCik: `000200000${i}`,
        acceptedAt: new Date(ASOF.getTime() - (5 + i * 2) * DAY_MS),
      }));
    }
    // Ticker CCC — 2 distinct buyers (cluster does NOT fire)
    for (let i = 0; i < 2; i++) {
      sectorTrades.push(makeTrade({
        issuerTicker: 'CCC', accession: `c${i}`, transactionCode: 'P',
        personCik: `000300000${i}`,
        acceptedAt: new Date(ASOF.getTime() - (5 + i * 2) * DAY_MS),
      }));
    }
    const rate = computeSectorClusterRate(sectorTrades, 20, ASOF);
    assertClose(rate, 0.1);  // 2 cluster tickers / 20 sector size
  });

  it('returns 0 when no ticker hits cluster threshold', () => {
    const sectorTrades = [
      makeTrade({ issuerTicker: 'AAA', accession: 'a', transactionCode: 'P',
        personCik: '0001000001' }),
      makeTrade({ issuerTicker: 'BBB', accession: 'b', transactionCode: 'P',
        personCik: '0002000001' }),
    ];
    const rate = computeSectorClusterRate(sectorTrades, 30, ASOF);
    assertClose(rate, 0);
  });

  it('returns null when sectorSize <= 0', () => {
    assert.equal(computeSectorClusterRate([], 0, ASOF), null);
    assert.equal(computeSectorClusterRate([], -1, ASOF), null);
  });

  it('cluster rate weights by ticker count, not by trade volume (one mega-cluster ticker = 1)', () => {
    const sectorTrades: InsiderTrade[] = [];
    // Ticker AAA — 10 distinct buyers (huge cluster but still 1 ticker)
    for (let i = 0; i < 10; i++) {
      sectorTrades.push(makeTrade({
        issuerTicker: 'AAA', accession: `a${i}`, transactionCode: 'P',
        personCik: `000100000${i}`,
      }));
    }
    const rate = computeSectorClusterRate(sectorTrades, 50, ASOF);
    assertClose(rate, 1 / 50);  // ONE ticker, not 10
  });
});

// ── T-F4-12: aggregate z with 30-print baseline ─────────────────────────────

describe('computeZ aggregate (T-F4-12)', () => {
  it('returns meaningful z when baseline >= MIN_Z_BASELINE prints', () => {
    const baseline: number[] = [];
    for (let i = 0; i < 40; i++) baseline.push(0.02 + ((i % 5) - 2) * 0.002);
    const result = computeZ(0.10, baseline);
    assert.ok(result.z != null);
    assert.ok(result.z > 2, `expected z > 2 outlier-high rate, got ${result.z}`);
    assert.equal(result.baselineSize, 40);
  });

  it('returns negative z for outlier-low value', () => {
    const baseline: number[] = [];
    for (let i = 0; i < 40; i++) baseline.push(0.10 + ((i % 5) - 2) * 0.005);
    const result = computeZ(0.02, baseline);
    assert.ok(result.z != null);
    assert.ok(result.z < -2, `expected z < -2, got ${result.z}`);
  });
});

// ── T-F4-13: aggregate z null on cold-start ─────────────────────────────────

describe('computeZ cold-start (T-F4-13)', () => {
  it('returns null z when baseline has fewer than MIN_Z_BASELINE prints', () => {
    const baseline = Array.from({ length: MIN_Z_BASELINE - 1 }, (_, i) => i / 100);
    const result = computeZ(0.10, baseline);
    assert.equal(result.z, null);
    assert.equal(result.baselineSize, MIN_Z_BASELINE - 1);
  });

  it('returns null z on empty baseline', () => {
    const result = computeZ(0.05, []);
    assert.equal(result.z, null);
    assert.equal(result.baselineSize, 0);
  });

  it('returns null z when value is null', () => {
    const baseline = Array.from({ length: 50 }, (_, i) => i / 1000);
    const result = computeZ(null, baseline);
    assert.equal(result.z, null);
  });

  it('returns null z when stddev is degenerate (all-identical baseline)', () => {
    const baseline = Array.from({ length: 50 }, () => 0.05);
    const result = computeZ(0.10, baseline);
    assert.equal(result.z, null);
    assert.equal(result.baselineSize, 50);
  });
});

// ── T-F4-14: form_4_cluster_flag fires when any sector |z| > 2.0 ────────────

describe('flagForm4Cluster (T-F4-14)', () => {
  it('fires when at least one sector z exceeds threshold', () => {
    assert.equal(flagForm4Cluster([0.5, 1.2, 2.5, -1.0]), true);
  });

  it('fires symmetrically on negative z (sector below baseline)', () => {
    assert.equal(flagForm4Cluster([0.5, -2.5, 1.0]), true);
  });

  it('does not fire when all |z| <= threshold', () => {
    assert.equal(flagForm4Cluster([0.5, 1.2, -1.9, 1.99]), false);
  });

  it('does not fire when all sector z-scores are null', () => {
    assert.equal(flagForm4Cluster([null, null, null]), false);
  });

  it('does not fire when null mixed with below-threshold', () => {
    assert.equal(flagForm4Cluster([null, 1.5, null, -1.8]), false);
  });

  it('via composite: surfaces flaggedSectors when |z| > 2', () => {
    const baseline: number[] = [];
    for (let i = 0; i < 60; i++) baseline.push(0.02 + ((i % 4) - 1.5) * 0.005);
    // Build sector with 6 cluster-buy tickers in a sector of size 30 → rate = 0.20
    const sectorTrades: InsiderTrade[] = [];
    for (let ti = 0; ti < 6; ti++) {
      const ticker = `T${ti}`;
      for (let pi = 0; pi < 3; pi++) {
        sectorTrades.push(makeTrade({
          issuerTicker: ticker, accession: `${ticker}-${pi}`,
          transactionCode: 'P',
          personCik: `0001${ti}${pi}00001`,
          acceptedAt: new Date(ASOF.getTime() - (5 + pi * 2) * DAY_MS),
        }));
      }
    }
    const inputs = makeInputs({
      sectors: [{
        sector: 'Information Technology',
        sectorSize: 30,
        trades: sectorTrades,
        baseline2y: baseline,
        baseline2ySell: [],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.flaggedSectors.length, 1);
    const flagged = snap.flaggedSectors[0];
    assert.equal(flagged.sector, 'Information Technology');
    assert.equal(flagged.sectorSize, 30);
    assertClose(flagged.clusterRateT, 6 / 30);
    assert.ok(Math.abs(flagged.z) > FORM_4_CLUSTER_Z_THRESHOLD);
    assert.equal(snap.form4ClusterFlag, true);
  });

  it('cold-start baseline does NOT flag cluster', () => {
    // 6 cluster-buy tickers — but the baseline is empty (cold start)
    const sectorTrades: InsiderTrade[] = [];
    for (let ti = 0; ti < 6; ti++) {
      const ticker = `T${ti}`;
      for (let pi = 0; pi < 3; pi++) {
        sectorTrades.push(makeTrade({
          issuerTicker: ticker, accession: `${ticker}-${pi}`,
          transactionCode: 'P', personCik: `0001${ti}${pi}00001`,
        }));
      }
    }
    const inputs = makeInputs({
      sectors: [{
        sector: 'Information Technology',
        sectorSize: 30,
        trades: sectorTrades,
        baseline2y: [],
        baseline2ySell: [],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.flaggedSectors.length, 0);
    assert.equal(snap.form4ClusterFlag, false);
  });
});

// ── dedupe (supplemental) ───────────────────────────────────────────────────

describe('dedupeTrades (supplemental)', () => {
  it('collapses duplicate (issuerCik, accession, transactionId) tuples', () => {
    const trades = [
      makeTrade({ issuerCik: '111', accession: 'A', transactionId: 0 }),
      makeTrade({ issuerCik: '111', accession: 'A', transactionId: 0 }),
      makeTrade({ issuerCik: '111', accession: 'A', transactionId: 1 }),
    ];
    const deduped = dedupeTrades(trades);
    assert.equal(deduped.length, 2);
  });

  it('preserves distinct transactionId within same accession (multi-txn Form 4)', () => {
    const trades = [
      makeTrade({ issuerCik: '111', accession: 'A', transactionId: 0 }),
      makeTrade({ issuerCik: '111', accession: 'A', transactionId: 1 }),
      makeTrade({ issuerCik: '111', accession: 'A', transactionId: 2 }),
    ];
    const deduped = dedupeTrades(trades);
    assert.equal(deduped.length, 3);
  });

  it('preserves distinct accessions from same issuer', () => {
    const trades = [
      makeTrade({ issuerCik: '111', accession: 'A', transactionId: 0 }),
      makeTrade({ issuerCik: '111', accession: 'B', transactionId: 0 }),
    ];
    const deduped = dedupeTrades(trades);
    assert.equal(deduped.length, 2);
  });

  it('via composite: per-direction count is correct after upstream duplicates', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'A', transactionId: 0, transactionCode: 'P',
            dollarAmount: 100 }),
          makeTrade({ accession: 'A', transactionId: 0, transactionCode: 'P',
            dollarAmount: 100 }),  // exact duplicate
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderBuyCount90d, 1);
    assertClose(snap.perTickerRows[0].insiderNetDollar90d, 100);
  });
});

// ── Composite orchestrator integration ──────────────────────────────────────

describe('evaluateForm4InsiderComposite (orchestrator)', () => {
  it('returns expected snapshot shape on empty inputs', () => {
    const snap = evaluateForm4InsiderComposite(makeInputs());
    assert.equal(snap.version, FORM_4_INSIDER_COMPOSITE_VERSION);
    assert.deepEqual([...snap.flaggedSectors], []);
    assert.equal(snap.form4ClusterFlag, false);
    assert.deepEqual([...snap.perTickerRows], []);
    assert.equal(snap.inputsAvailableAggregate, 0);
    assert.equal(snap.inputsAvailablePerTicker, 0);
  });

  it('inputsAvailablePerTicker counts only rows with non-null sector + non-empty CIK', () => {
    const inputs = makeInputs({
      perTicker: [
        { ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology', trades: [] },
        { ticker: 'NOSEC', cik: '0000123456', sector: null, trades: [] },
        { ticker: 'NOCIK', cik: '', sector: 'Health Care', trades: [] },
        { ticker: 'BOTH',  cik: '', sector: null, trades: [] },
      ],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.inputsAvailablePerTicker, 1);
    assert.equal(snap.perTickerRows.length, 4);
  });

  it('inputsAvailableAggregate counts sectors with sectorSize > 0', () => {
    const inputs = makeInputs({
      sectors: [
        { sector: 'A', sectorSize: 30, trades: [], baseline2y: [], baseline2ySell: [] },
        { sector: 'B', sectorSize: 0, trades: [], baseline2y: [], baseline2ySell: [] },
        { sector: 'C', sectorSize: 50, trades: [], baseline2y: [], baseline2ySell: [] },
      ],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.inputsAvailableAggregate, 2);
  });

  it('threads lastEdgarQueryAt + bdSinceLastQuery through to the snapshot', () => {
    const queryAt = new Date('2026-05-20T08:00:00Z');
    const inputs = makeInputs({ lastEdgarQueryAt: queryAt, bdSinceLastQuery: 2 });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.lastEdgarQueryAt, queryAt);
    assert.equal(snap.bdSinceLastQuery, 2);
  });

  it('per-ticker layer derives all 7 fields from a mixed trade panel', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          // 3 distinct buyers in 30d (cluster fires)
          makeTrade({ accession: 'a', transactionCode: 'P', personCik: '0001000001',
            dollarAmount: 100_000,
            acceptedAt: new Date(ASOF.getTime() - 5 * DAY_MS) }),
          makeTrade({ accession: 'b', transactionCode: 'P', personCik: '0001000002',
            dollarAmount: 50_000,
            acceptedAt: new Date(ASOF.getTime() - 10 * DAY_MS) }),
          makeTrade({ accession: 'c', transactionCode: 'P', personCik: '0001000003',
            dollarAmount: 25_000,
            acceptedAt: new Date(ASOF.getTime() - 15 * DAY_MS) }),
          // 1 seller in 90d (not a cluster)
          makeTrade({ accession: 'd', transactionCode: 'S', personCik: '0001000004',
            dollarAmount: 80_000,
            acceptedAt: new Date(ASOF.getTime() - 60 * DAY_MS) }),
          // Off-set code that should be filtered out
          makeTrade({ accession: 'e', transactionCode: 'A', personCik: '0001000005',
            dollarAmount: 999_999_999 }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.insiderBuyCount90d, 3);
    assert.equal(row.insiderSellCount90d, 1);
    assert.equal(row.insiderBuyerCount90d, 3);
    assert.equal(row.insiderSellerCount90d, 1);
    assertClose(row.insiderNetDollar90d, 100_000 + 50_000 + 25_000 - 80_000);
    assert.equal(row.insiderClusterBuyFlag, true);
    assert.equal(row.insiderClusterSellFlag, false);
  });

  it('per-ticker layer dedupes trades before counting (load-bearing for buy_count)', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionId: 0, transactionCode: 'P',
            personCik: '0001000001', dollarAmount: 100 }),
          // Re-ingest duplicate of same row:
          makeTrade({ accession: 'a', transactionId: 0, transactionCode: 'P',
            personCik: '0001000001', dollarAmount: 100 }),
          makeTrade({ accession: 'a', transactionId: 1, transactionCode: 'P',
            personCik: '0001000002', dollarAmount: 50 }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    // Should see 2 distinct trades after dedupe, not 3.
    assert.equal(snap.perTickerRows[0].insiderBuyCount90d, 2);
    assertClose(snap.perTickerRows[0].insiderNetDollar90d, 150);
  });
});

// ── Cross-cutting: ingest-time off-set codes don't leak via composite ───────

describe('S93-37 load-bearing: composite filters off-set codes (cross-cutting)', () => {
  it('filterTradesToHighSignalCodes drops the Python ingest tail', () => {
    // Emulate F4-A1 ingest stream — ALL codes stored at the raw table.
    const trades = [
      makeTrade({ accession: '1', transactionCode: 'P' }),
      makeTrade({ accession: '2', transactionCode: 'S' }),
      makeTrade({ accession: '3', transactionCode: 'A' }),
      makeTrade({ accession: '4', transactionCode: 'M' }),
      makeTrade({ accession: '5', transactionCode: 'F' }),
      makeTrade({ accession: '6', transactionCode: 'G' }),
      makeTrade({ accession: '7', transactionCode: 'D' }),
      makeTrade({ accession: '8', transactionCode: 'X' }),
    ];
    const filtered = filterTradesToHighSignalCodes(trades);
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].transactionCode, 'P');
    assert.equal(filtered[1].transactionCode, 'S');
  });

  it('composite does NOT count A-grants in insider_buy_count_90d', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          // 100k shares granted as compensation — must NOT count as a buy.
          makeTrade({
            accession: 'a', transactionCode: 'A',
            shares: 100_000, pricePerShare: 0, dollarAmount: 0,
            personCik: '0001000001',
          }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderBuyCount90d, 0);
    assert.equal(snap.perTickerRows[0].insiderBuyerCount90d, 0);
  });

  it('composite does NOT count M-exercises as a buy', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({
            accession: 'a', transactionCode: 'M',
            shares: 1000, pricePerShare: 50, dollarAmount: 50_000,
            personCik: '0001000001',
          }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows[0].insiderBuyCount90d, 0);
    assert.equal(snap.perTickerRows[0].insiderNetDollar90d, 0);
  });
});

// ── MAXZ-F4-{1..4} aggregate-layer max-|z| observability ────────────────────
// SPEC docs/specs/gics-sector-baseline-computation.md §5.2 + §2.
// ADR-042 §1 Decision §1 — maxAggregateZ / maxAggregateZSector exposed at the
// composite-evaluator boundary for the brief renderer's §1.4 LIVE branch.

describe('aggregate-layer maxAggregateZ + maxAggregateZSector (MAXZ-F4-1..4)', () => {
  function makeBaseline(): number[] {
    const b: number[] = [];
    for (let i = 0; i < 60; i++) b.push(0.02 + ((i % 4) - 1.5) * 0.005);
    return b;
  }

  // Build trades that produce a buy-cluster fire on `tickerCount` distinct
  // tickers in a sector (≥ 3 distinct personCiks per ticker within 30d).
  // Mirrors the existing T-F4 "via composite" test pattern.
  function makeSectorClusterTrades(tickerCount: number): InsiderTrade[] {
    const trades: InsiderTrade[] = [];
    for (let ti = 0; ti < tickerCount; ti++) {
      const ticker = `T${ti}`;
      for (let pi = 0; pi < 3; pi++) {
        trades.push(makeTrade({
          issuerTicker: ticker, accession: `${ticker}-${pi}`,
          transactionCode: 'P',
          personCik: `0001${ti}${pi}00001`,
          acceptedAt: new Date(ASOF.getTime() - (5 + pi * 2) * DAY_MS),
        }));
      }
    }
    return trades;
  }

  // Replicate the evaluator's per-sector cluster-rate derivation so the
  // expected-z computation is byte-identical to the evaluator's path.
  function expectedRate(
    trades: ReadonlyArray<InsiderTrade>,
    sectorSize: number,
  ): number | null {
    const deduped = dedupeTrades(trades);
    const psFiltered = filterTradesToHighSignalCodes(deduped);
    const inWindow = filterTradesInWindow(psFiltered, ASOF, ROLLING_WINDOW_DAYS);
    return computeSectorClusterRate(inWindow, sectorSize, ASOF);
  }

  it('MAXZ-F4-1: maxAggregateZ is the signed z of the max-|z| sector', () => {
    const baseline = makeBaseline();
    const inputs = makeInputs({
      sectors: [
        { sector: 'Energy', sectorSize: 30, trades: makeSectorClusterTrades(8), baseline2y: baseline, baseline2ySell: [] },
        { sector: 'Health Care', sectorSize: 30, trades: makeSectorClusterTrades(2), baseline2y: baseline, baseline2ySell: [] },
        { sector: 'Materials', sectorSize: 30, trades: makeSectorClusterTrades(4), baseline2y: baseline, baseline2ySell: [] },
      ],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    const expectedZs = inputs.sectors.map((s) => ({
      sector: s.sector,
      z: computeZ(expectedRate(s.trades, s.sectorSize), s.baseline2y).z,
    }));
    let bestZ: number | null = null;
    let bestAbs = -Infinity;
    for (const r of expectedZs) {
      if (r.z != null && Math.abs(r.z) > bestAbs) {
        bestAbs = Math.abs(r.z);
        bestZ = r.z;
      }
    }
    assert.ok(bestZ != null, 'expected at least one non-null z in test setup');
    assert.equal(snap.maxAggregateZ, bestZ);
  });

  it('MAXZ-F4-2: maxAggregateZSector names the sector with max |z|', () => {
    const baseline = makeBaseline();
    const inputs = makeInputs({
      sectors: [
        { sector: 'Energy', sectorSize: 30, trades: makeSectorClusterTrades(8), baseline2y: baseline, baseline2ySell: [] },
        { sector: 'Health Care', sectorSize: 30, trades: makeSectorClusterTrades(2), baseline2y: baseline, baseline2ySell: [] },
        { sector: 'Materials', sectorSize: 30, trades: makeSectorClusterTrades(4), baseline2y: baseline, baseline2ySell: [] },
      ],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    const expectedZs = inputs.sectors.map((s) => ({
      sector: s.sector,
      z: computeZ(expectedRate(s.trades, s.sectorSize), s.baseline2y).z,
    }));
    let bestAbs = -Infinity;
    let expectedSector: string | null = null;
    for (const r of expectedZs) {
      if (r.z != null && Math.abs(r.z) > bestAbs) {
        bestAbs = Math.abs(r.z);
        expectedSector = r.sector;
      }
    }
    assert.equal(snap.maxAggregateZSector, expectedSector);
    assert.equal(snap.maxAggregateZSector, 'Energy');
  });

  it('MAXZ-F4-3: both fields null when all sector z\'s are null (cold-start)', () => {
    const inputs = makeInputs({
      sectors: [
        { sector: 'Energy', sectorSize: 30, trades: makeSectorClusterTrades(8), baseline2y: [], baseline2ySell: [] },
        { sector: 'Materials', sectorSize: 30, trades: makeSectorClusterTrades(4), baseline2y: [], baseline2ySell: [] },
      ],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.maxAggregateZ, null);
    assert.equal(snap.maxAggregateZSector, null);
  });

  it('MAXZ-F4-4: ties broken lexicographically (earlier sector name wins; input order-independent)', () => {
    const baseline = makeBaseline();
    const trades = makeSectorClusterTrades(5);
    const inputsA = makeInputs({
      sectors: [
        { sector: 'Materials', sectorSize: 40, trades, baseline2y: baseline, baseline2ySell: [] },
        { sector: 'Energy', sectorSize: 40, trades, baseline2y: baseline, baseline2ySell: [] },
      ],
    });
    const inputsB = makeInputs({
      sectors: [
        { sector: 'Energy', sectorSize: 40, trades, baseline2y: baseline, baseline2ySell: [] },
        { sector: 'Materials', sectorSize: 40, trades, baseline2y: baseline, baseline2ySell: [] },
      ],
    });
    const snapA = evaluateForm4InsiderComposite(inputsA);
    const snapB = evaluateForm4InsiderComposite(inputsB);
    assert.equal(snapA.maxAggregateZSector, 'Energy');
    assert.equal(snapB.maxAggregateZSector, 'Energy');
    assert.equal(snapA.maxAggregateZ, snapB.maxAggregateZ);
  });
});

// ── F4-12 v2 (S95-1): sell-cluster sector aggregation ───────────────────────

describe('F4-12 v2 sell-cluster sector aggregation (G2-SELL-*)', () => {
  function makeBaseline(): number[] {
    const b: number[] = [];
    for (let i = 0; i < 60; i++) b.push(0.02 + ((i % 4) - 1.5) * 0.005);
    return b;
  }

  function makeSectorClusterTrades(
    nClusterTickers: number,
    code: 'P' | 'S' = 'P',
  ): InsiderTrade[] {
    const trades: InsiderTrade[] = [];
    for (let ti = 0; ti < nClusterTickers; ti++) {
      const ticker = `T${ti}`;
      for (let pi = 0; pi < 3; pi++) {
        trades.push(makeTrade({
          issuerTicker: ticker, accession: `${ticker}-${pi}`,
          transactionCode: code,
          personCik: `0001${ti}${pi}00001`,
          acceptedAt: new Date(ASOF.getTime() - (5 + pi * 2) * DAY_MS),
        }));
      }
    }
    return trades;
  }

  // G2-SELL-F4-1 — computeSectorClusterRate with direction='S' counts sell-clusters.
  it('G2-SELL-F4-1: computeSectorClusterRate(direction=S) returns sell-cluster-rate', () => {
    // 2 tickers in a sector of 20 with ≥ 3 distinct sellers each → sell-rate = 0.1
    const sectorTrades: InsiderTrade[] = [];
    for (let ti = 0; ti < 2; ti++) {
      const ticker = `T${ti}`;
      for (let pi = 0; pi < 3; pi++) {
        sectorTrades.push(makeTrade({
          issuerTicker: ticker, accession: `${ticker}-${pi}`,
          transactionCode: 'S',
          personCik: `0002${ti}${pi}00001`,
        }));
      }
    }
    const rate = computeSectorClusterRate(sectorTrades, 20, ASOF, SELL_CODE);
    assertClose(rate, 0.1);
  });

  // G2-SELL-F4-2 — default direction preserves byte-equal buy-side semantics.
  it('G2-SELL-F4-2: default direction is byte-equal to direction=P (backward-compat)', () => {
    const sectorTrades: InsiderTrade[] = [];
    for (let ti = 0; ti < 3; ti++) {
      const ticker = `T${ti}`;
      for (let pi = 0; pi < 3; pi++) {
        sectorTrades.push(makeTrade({
          issuerTicker: ticker, accession: `${ticker}-${pi}`,
          transactionCode: 'P',
          personCik: `0001${ti}${pi}00001`,
        }));
      }
    }
    const rateDefault = computeSectorClusterRate(sectorTrades, 30, ASOF);
    const rateExplicit = computeSectorClusterRate(sectorTrades, 30, ASOF, BUY_CODE);
    assert.equal(rateDefault, rateExplicit);
    assertClose(rateDefault, 3 / 30);
    // Direction matters: same panel, direction='S' produces 0 sell-clusters.
    const rateSell = computeSectorClusterRate(sectorTrades, 30, ASOF, SELL_CODE);
    assertClose(rateSell, 0);
  });

  // G2-SELL-F4-3 — orchestrator emits form4SellClusterFlag=true on sell-side anomaly.
  it('G2-SELL-F4-3: form4SellClusterFlag fires on sell-side |z| > 2.0', () => {
    const baseline = makeBaseline();
    // 6 sell-cluster tickers in sector of 30 → sell-rate = 0.20, well above
    // baseline mean ~0.02; |z| > 2 expected with this baseline shape.
    const inputs = makeInputs({
      sectors: [{
        sector: 'Information Technology',
        sectorSize: 30,
        trades: makeSectorClusterTrades(6, 'S'),
        baseline2y: [],
        baseline2ySell: baseline,
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.form4SellClusterFlag, true);
    assert.equal(snap.flaggedSellSectors.length, 1);
    const flagged = snap.flaggedSellSectors[0];
    assert.equal(flagged.sector, 'Information Technology');
    assert.equal(flagged.sectorSize, 30);
    assertClose(flagged.clusterRateT, 6 / 30);
    assert.ok(Math.abs(flagged.z) > FORM_4_CLUSTER_Z_THRESHOLD);
    // Buy-side independent: cold-start baseline2y → buy-z null → buy-flag false.
    assert.equal(snap.form4ClusterFlag, false);
    assert.equal(snap.flaggedSectors.length, 0);
  });

  // G2-SELL-F4-4 — buy + sell flags are independent; both can fire concurrently.
  // The independence invariant is about the FLAGS, not about whether a sector
  // appears in exactly one direction's flagged set (a zero-rate today against
  // a non-zero baseline mean produces a negative-z that the symmetric |z| > 2
  // test legitimately flags — same posture as F4-6 and AFML §1.3).
  it('G2-SELL-F4-4: buy + sell flags are independent (both can fire concurrently)', () => {
    const baseline = makeBaseline();
    const inputs = makeInputs({
      sectors: [
        // Sector A: positive buy-side anomaly (6 buy-cluster tickers).
        {
          sector: 'Energy',
          sectorSize: 30,
          trades: makeSectorClusterTrades(6, 'P'),
          baseline2y: baseline,
          baseline2ySell: baseline,
        },
        // Sector B: positive sell-side anomaly (6 sell-cluster tickers).
        {
          sector: 'Financials',
          sectorSize: 30,
          trades: makeSectorClusterTrades(6, 'S'),
          baseline2y: baseline,
          baseline2ySell: baseline,
        },
      ],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.form4ClusterFlag, true, 'buy-side flag fires');
    assert.equal(snap.form4SellClusterFlag, true, 'sell-side flag fires');
    const flaggedBuyByName = new Set(snap.flaggedSectors.map(f => f.sector));
    const flaggedSellByName = new Set(snap.flaggedSellSectors.map(f => f.sector));
    // Each direction's primary-anomaly sector appears in its own bucket.
    assert.ok(flaggedBuyByName.has('Energy'),
      'Energy (positive buy-cluster anomaly) flagged on buy-side');
    assert.ok(flaggedSellByName.has('Financials'),
      'Financials (positive sell-cluster anomaly) flagged on sell-side');
    // Look at the max-z sectors: max |z| on each direction must be the sector
    // whose actual trades match that direction.
    assert.equal(snap.maxAggregateZSector, 'Energy',
      'max |z| on buy-side is Energy (positive z dominates)');
    assert.equal(snap.maxAggregateZSellSector, 'Financials',
      'max |z| on sell-side is Financials (positive z dominates)');
  });

  // G2-SELL-F4-5 — maxAggregateZSell + sector are populated symmetrically;
  // tie-break is the same lexicographic rule as the buy-side counterpart.
  it('G2-SELL-F4-5: maxAggregateZSell + maxAggregateZSellSector populated symmetrically', () => {
    const baseline = makeBaseline();
    // Two sectors with IDENTICAL sell trade panels — z's tie; lexicographic
    // tie-break picks the earlier name ("Energy" < "Materials").
    const trades = makeSectorClusterTrades(5, 'S');
    const inputs = makeInputs({
      sectors: [
        { sector: 'Materials', sectorSize: 40, trades, baseline2y: [], baseline2ySell: baseline },
        { sector: 'Energy', sectorSize: 40, trades, baseline2y: [], baseline2ySell: baseline },
      ],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.maxAggregateZSellSector, 'Energy');
    assert.ok(snap.maxAggregateZSell != null && Math.abs(snap.maxAggregateZSell) > 0);
    // Buy-side stays null (empty buy baseline).
    assert.equal(snap.maxAggregateZ, null);
    assert.equal(snap.maxAggregateZSector, null);
  });

  // G2-SELL-F4-6 — cold-start (empty sell baseline) → form4SellClusterFlag=false,
  // flaggedSellSectors=[], maxAggregateZSell=null, maxAggregateZSellSector=null.
  it('G2-SELL-F4-6: cold-start (empty baseline2ySell) → sell-side fields cold-start', () => {
    const snapEmpty = evaluateForm4InsiderComposite(makeInputs());
    assert.equal(snapEmpty.form4SellClusterFlag, false);
    assert.deepEqual([...snapEmpty.flaggedSellSectors], []);
    assert.equal(snapEmpty.maxAggregateZSell, null);
    assert.equal(snapEmpty.maxAggregateZSellSector, null);

    // Even with a sell-cluster fixture, empty baseline2ySell forces cold-start.
    const inputs = makeInputs({
      sectors: [{
        sector: 'Information Technology',
        sectorSize: 30,
        trades: makeSectorClusterTrades(6, 'S'),
        baseline2y: [],
        baseline2ySell: [],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.form4SellClusterFlag, false);
    assert.deepEqual([...snap.flaggedSellSectors], []);
    assert.equal(snap.maxAggregateZSell, null);
    assert.equal(snap.maxAggregateZSellSector, null);
  });
});

// ── Constants sanity ────────────────────────────────────────────────────────

describe('constants (sanity)', () => {
  it('exposes the expected SPEC-pinned values', () => {
    assert.equal(FORM_4_INSIDER_COMPOSITE_VERSION, 'form_4_insider_v1');
    assert.equal(ROLLING_WINDOW_DAYS, 90);
    assert.equal(CLUSTER_WINDOW_DAYS, 30);
    assert.equal(CLUSTER_INSIDER_THRESHOLD, 3);
    assert.equal(FORM_4_CLUSTER_Z_THRESHOLD, 2.0);
    assert.equal(MIN_Z_BASELINE, 30);
    assert.deepEqual([...HIGH_SIGNAL_TRANSACTION_CODES], ['P', 'S']);
    assert.equal(BUY_CODE, 'P');
    assert.equal(SELL_CODE, 'S');
  });
});
