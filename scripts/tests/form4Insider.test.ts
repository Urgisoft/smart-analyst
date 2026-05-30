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
  FORM_4_EXCEEDANCE_ALPHA,
  EVENT_FLOOR,
  MIN_Z_BASELINE,
  HIGH_SIGNAL_TRANSACTION_CODES,
  BUY_CODE,
  SELL_CODE,
  EDGAR_CANONICAL_SOURCE,
  dedupeTrades,
  filterTradesToHighSignalCodes,
  filterTradesToCanonicalSource,
  filterTradesInWindow,
  countTradesByCode,
  sumDollarsByCode,
  computeInsiderNetDollar,
  countDistinctInsidersByCode,
  daysSinceLatestTradeByCode,
  flagInsiderCluster,
  computeSectorClusterRate,
  computeZ,
  computeEmpiricalExceedance,
  countNonZeroRuns,
  flagForm4Cluster,
  flagForm4ClusterEmpirical,
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
 *  on AAPL 10 days before ASOF, 100 shares at $150 = $15,000.
 *
 *  ADR-052: `source` defaults to `EDGAR_CANONICAL_SOURCE` so every existing
 *  cluster assertion (which predates the source split) keeps firing — the
 *  cluster path is now EDGAR-only. Tests of the new source-filter behavior
 *  pass `source: 'finnhub'` explicitly. */
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
    source: overrides.source ?? EDGAR_CANONICAL_SOURCE,
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

  it('via composite: surfaces flaggedSectors when the empirical α-tail fires', () => {
    // ADR-054: the baseline must contain ≥ EVENT_FLOOR=20 distinct INDEPENDENT
    // events (maximal non-zero runs) to be valid — a contiguous non-zero run is
    // ONE event and would be guard-suppressed. Lay 25 isolated small non-zero
    // days (separated by zeros) → 25 events, n=50 ≥ 30; today's 0.20 rate exceeds
    // every baseline day → exceedance ≤ α → fires.
    const baseline: number[] = [];
    for (let i = 0; i < 25; i++) {
      baseline.push(0.02 + ((i % 4) - 1.5) * 0.005);
      baseline.push(0);
    }
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
    // ADR-053: a flagged sector cleared the empirical α-tail; zEmp is bounded.
    assert.ok(flagged.exceedance <= FORM_4_EXCEEDANCE_ALPHA);
    assert.ok(flagged.zEmp >= 0 && flagged.zEmp < 2.6,
      `zEmp must be bounded, got ${flagged.zEmp}`);
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
  // ADR-054 (OQ-C36-1): the validity guard now counts distinct INDEPENDENT
  // EVENTS (maximal non-zero runs), not non-zero days, and requires
  // effectiveEvents ≥ EVENT_FLOOR = 20. A baseline of contiguous non-zero values
  // is ONE event and would be suppressed; the helper therefore lays the non-zero
  // values as ISOLATED events (separated by zeros) so a genuine anomaly fixture
  // clears the event floor. 25 small (~0.02) isolated non-zero days → 25 events,
  // n=50 ≥ 30; today's cluster-rate (≥ 0.1) exceeds every baseline day → fires.
  function makeBaseline(): number[] {
    const b: number[] = [];
    for (let i = 0; i < 25; i++) {
      b.push(0.02 + ((i % 4) - 1.5) * 0.005); // an isolated non-zero event
      b.push(0);                              // a zero separating it from the next
    }
    return b; // length 50, 25 distinct events, all values ≤ 0.0275
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

  it('MAXZ-F4-1: maxAggregateZ is the max bounded zEmp across valid sectors (ADR-053)', () => {
    const baseline = makeBaseline();
    const inputs = makeInputs({
      sectors: [
        { sector: 'Energy', sectorSize: 30, trades: makeSectorClusterTrades(8), baseline2y: baseline, baseline2ySell: [] },
        { sector: 'Health Care', sectorSize: 30, trades: makeSectorClusterTrades(2), baseline2y: baseline, baseline2ySell: [] },
        { sector: 'Materials', sectorSize: 30, trades: makeSectorClusterTrades(4), baseline2y: baseline, baseline2ySell: [] },
      ],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    const expected = inputs.sectors.map((s) => ({
      sector: s.sector,
      zEmp: computeEmpiricalExceedance(expectedRate(s.trades, s.sectorSize), s.baseline2y).zEmp,
    }));
    let bestZ: number | null = null;
    for (const r of expected) {
      if (r.zEmp != null && (bestZ == null || r.zEmp > bestZ)) bestZ = r.zEmp;
    }
    assert.ok(bestZ != null, 'expected at least one non-null zEmp in test setup');
    assert.equal(snap.maxAggregateZ, bestZ);
    // Bounded — never a fabricated σ.
    assert.ok((snap.maxAggregateZ ?? 0) >= 0 && (snap.maxAggregateZ ?? 0) < 2.6);
  });

  it('MAXZ-F4-2: maxAggregateZSector names the sector with max zEmp', () => {
    const baseline = makeBaseline();
    const inputs = makeInputs({
      sectors: [
        { sector: 'Energy', sectorSize: 30, trades: makeSectorClusterTrades(8), baseline2y: baseline, baseline2ySell: [] },
        { sector: 'Health Care', sectorSize: 30, trades: makeSectorClusterTrades(2), baseline2y: baseline, baseline2ySell: [] },
        { sector: 'Materials', sectorSize: 30, trades: makeSectorClusterTrades(4), baseline2y: baseline, baseline2ySell: [] },
      ],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    const expected = inputs.sectors.map((s) => ({
      sector: s.sector,
      zEmp: computeEmpiricalExceedance(expectedRate(s.trades, s.sectorSize), s.baseline2y).zEmp,
    }));
    let bestZ = -Infinity;
    let expectedSector: string | null = null;
    for (const r of expected) {
      // Lexicographic tie-break mirrors the evaluator.
      if (r.zEmp != null && (r.zEmp > bestZ || (r.zEmp === bestZ && (expectedSector == null || r.sector < expectedSector)))) {
        bestZ = r.zEmp;
        expectedSector = r.sector;
      }
    }
    assert.equal(snap.maxAggregateZSector, expectedSector);
    // Energy has the highest cluster-rate (8 tickers) → strongest exceedance.
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
  // ADR-054 (OQ-C36-1): isolated non-zero events (separated by zeros) so the
  // baseline clears EVENT_FLOOR = 20 distinct events; a contiguous non-zero run
  // would be ONE event and would be guard-suppressed. 25 events, n=50 ≥ 30, all
  // values ≤ 0.0275 so a 0.10–0.20 cluster-rate today exceeds every baseline day.
  function makeBaseline(): number[] {
    const b: number[] = [];
    for (let i = 0; i < 25; i++) {
      b.push(0.02 + ((i % 4) - 1.5) * 0.005);
      b.push(0);
    }
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
  it('G2-SELL-F4-3: form4SellClusterFlag fires on sell-side empirical α-tail (ADR-053)', () => {
    const baseline = makeBaseline();
    // 6 sell-cluster tickers in sector of 30 → sell-rate = 0.20, well above
    // every baseline day → exceedance ≤ α → fires.
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
    assert.ok(flagged.exceedance <= FORM_4_EXCEEDANCE_ALPHA);
    assert.ok(flagged.zEmp >= 0 && flagged.zEmp < 2.6);
    // Buy-side independent: cold-start baseline2y → buy-stat null → buy-flag false.
    assert.equal(snap.form4ClusterFlag, false);
    assert.equal(snap.flaggedSectors.length, 0);
  });

  // G2-SELL-F4-4 — buy + sell flags are independent; both can fire concurrently.
  // The independence invariant is about the FLAGS. ADR-053: the empirical tail is
  // ONE-SIDED, so a zero-rate today (Financials buy, Energy sell) yields
  // exceedance ≈ 1.0 → zEmp 0 → does NOT fire its opposite direction; only the
  // direction whose trades match fires.
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
    // ADR-054 (OQ-C36-1): version bumped to v4 (event-count effective-sample
    // guard; the empirical-exceedance statistic from v3/ADR-053 is unchanged).
    assert.equal(FORM_4_INSIDER_COMPOSITE_VERSION, 'form_4_insider_v4');
    assert.equal(ROLLING_WINDOW_DAYS, 90);
    assert.equal(CLUSTER_WINDOW_DAYS, 30);
    assert.equal(CLUSTER_INSIDER_THRESHOLD, 3);
    // @deprecated under ADR-053 but still pinned for the historical-reference trail.
    assert.equal(FORM_4_CLUSTER_Z_THRESHOLD, 2.0);
    // ADR-053: the single conventional significance level driving both guards
    // AND the firing threshold.
    assert.equal(FORM_4_EXCEEDANCE_ALPHA, 0.05);
    // ADR-054 D2: the α-derived event floor — derives SOLELY from α (zero new
    // free parameters), and equals ⌈1/0.05⌉ = 20.
    assert.equal(EVENT_FLOOR, Math.ceil(1 / FORM_4_EXCEEDANCE_ALPHA));
    assert.equal(EVENT_FLOOR, 20);
    assert.equal(MIN_Z_BASELINE, 30);
    assert.deepEqual([...HIGH_SIGNAL_TRANSACTION_CODES], ['P', 'S']);
    assert.equal(BUY_CODE, 'P');
    assert.equal(SELL_CODE, 'S');
  });
});


// ── T-F4-DSLB-{1..5} — daysSinceLatestTradeByCode + composite wiring ────────
//
// Gap #7 v2 per-row recency (S95 #4): adds `daysSinceLatestBuy` /
// `daysSinceLatestSell` to the per-ticker row payload so the SPEC §8.2
// "last 23d" recency hint lands on F4 cluster_buy / cluster_sell brief rows.

describe('daysSinceLatestTradeByCode', () => {
  it('T-F4-DSLB-1 returns days since most-recent trade in window for matching code', () => {
    const trades = [
      makeTrade({ acceptedAt: new Date(ASOF.getTime() - 23 * DAY_MS), transactionCode: 'P', personCik: 'A' }),
      makeTrade({ acceptedAt: new Date(ASOF.getTime() - 41 * DAY_MS), transactionCode: 'P', personCik: 'B' }),
      makeTrade({ acceptedAt: new Date(ASOF.getTime() - 7 * DAY_MS),  transactionCode: 'P', personCik: 'C' }),
    ];
    assert.equal(daysSinceLatestTradeByCode(trades, 'P', ASOF), 7);
  });

  it('T-F4-DSLB-2 returns null when window contains zero trades of the requested code', () => {
    const trades = [
      makeTrade({ acceptedAt: new Date(ASOF.getTime() - 10 * DAY_MS), transactionCode: 'P' }),
    ];
    assert.equal(daysSinceLatestTradeByCode(trades, 'S', ASOF), null);
    assert.equal(daysSinceLatestTradeByCode([], 'P', ASOF), null);
  });

  it('T-F4-DSLB-3 isolates by direction — P-side recency ignores S-side trades and vice versa', () => {
    const trades = [
      makeTrade({ acceptedAt: new Date(ASOF.getTime() - 3 * DAY_MS),  transactionCode: 'S', personCik: 'S1' }),
      makeTrade({ acceptedAt: new Date(ASOF.getTime() - 30 * DAY_MS), transactionCode: 'P', personCik: 'P1' }),
    ];
    assert.equal(daysSinceLatestTradeByCode(trades, 'P', ASOF), 30);
    assert.equal(daysSinceLatestTradeByCode(trades, 'S', ASOF), 3);
  });

  it('T-F4-DSLB-4 floors fractional days (a trade 23.5d ago is "23d", not "24d")', () => {
    const trades = [
      makeTrade({
        acceptedAt: new Date(ASOF.getTime() - (23 * DAY_MS + 12 * 60 * 60 * 1000)),
        transactionCode: 'P',
      }),
    ];
    assert.equal(daysSinceLatestTradeByCode(trades, 'P', ASOF), 23);
  });

  it('T-F4-DSLB-5 evaluateForm4InsiderComposite populates daysSinceLatestBuy + daysSinceLatestSell on the per-ticker row', () => {
    // Distinct accessions per trade so dedupeTrades() doesn't collapse them.
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'QRST', cik: '0000222222', sector: null,
        trades: [
          makeTrade({ accession: 'X1', acceptedAt: new Date(ASOF.getTime() - 23 * DAY_MS), transactionCode: 'P', personCik: 'B1' }),
          makeTrade({ accession: 'X2', acceptedAt: new Date(ASOF.getTime() - 12 * DAY_MS), transactionCode: 'P', personCik: 'B2' }),
          makeTrade({ accession: 'X3', acceptedAt: new Date(ASOF.getTime() - 41 * DAY_MS), transactionCode: 'S', personCik: 'S1' }),
        ],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    assert.equal(snap.perTickerRows.length, 1);
    assert.equal(snap.perTickerRows[0]!.daysSinceLatestBuy, 12);
    assert.equal(snap.perTickerRows[0]!.daysSinceLatestSell, 41);

    // Zero-trade ticker produces null on both directions (cold-start).
    const zeroInputs = makeInputs({
      perTicker: [{ ticker: 'EMPTY', cik: '0000333333', sector: null, trades: [] }],
    });
    const zeroSnap = evaluateForm4InsiderComposite(zeroInputs);
    assert.equal(zeroSnap.perTickerRows[0]!.daysSinceLatestBuy, null);
    assert.equal(zeroSnap.perTickerRows[0]!.daysSinceLatestSell, null);
  });
});

// ── ADR-052 D1/D3/D4 — source-provenance normalization (S96-146) ────────────
//
// The cluster path (per-ticker cluster flags, sector cluster-rate, aggregate
// z) is EDGAR-ONLY because "distinct insider" is only well-defined under the
// real EDGAR reporting-person CIK; Finnhub's `person_cik` is a synthetic
// name-hash (S96-145). Raw counts stay dual-source with a source-mix label.

describe('ADR-052 source-provenance normalization (D1/D3/D4)', () => {
  it('T-F4-ADR052-1: filterTradesToCanonicalSource retains EDGAR only', () => {
    const trades = [
      makeTrade({ accession: 'e1', source: EDGAR_CANONICAL_SOURCE }),
      makeTrade({ accession: 'f1', source: 'finnhub' }),
      makeTrade({ accession: 'x1', source: '' }),
    ];
    const filtered = filterTradesToCanonicalSource(trades);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].source, EDGAR_CANONICAL_SOURCE);
  });

  it('T-F4-ADR052-2: 3 distinct EDGAR insiders → cluster-buy flag fires', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', personCik: '0001000001',
            source: EDGAR_CANONICAL_SOURCE,
            acceptedAt: new Date(ASOF.getTime() - 5 * DAY_MS) }),
          makeTrade({ accession: 'b', transactionCode: 'P', personCik: '0001000002',
            source: EDGAR_CANONICAL_SOURCE,
            acceptedAt: new Date(ASOF.getTime() - 10 * DAY_MS) }),
          makeTrade({ accession: 'c', transactionCode: 'P', personCik: '0001000003',
            source: EDGAR_CANONICAL_SOURCE,
            acceptedAt: new Date(ASOF.getTime() - 20 * DAY_MS) }),
        ],
      }],
    });
    const row = evaluateForm4InsiderComposite(inputs).perTickerRows[0];
    assert.equal(row.insiderClusterBuyFlag, true);
    assert.equal(row.insiderBuyCount90d, 3);
    assert.deepEqual(row.insiderCountSourceMix, { edgar: 3, finnhub: 0 });
  });

  it('T-F4-ADR052-3: 2 EDGAR + 1 Finnhub distinct insiders → cluster flag OFF (Finnhub excluded from identity) but raw count still 3, source-mix {2,1}', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', personCik: '0001000001',
            source: EDGAR_CANONICAL_SOURCE,
            acceptedAt: new Date(ASOF.getTime() - 5 * DAY_MS) }),
          makeTrade({ accession: 'b', transactionCode: 'P', personCik: '0001000002',
            source: EDGAR_CANONICAL_SOURCE,
            acceptedAt: new Date(ASOF.getTime() - 10 * DAY_MS) }),
          // Finnhub — synthetic identity; MUST NOT count toward cluster
          // distinctness even though it is the 3rd distinct person_cik.
          makeTrade({ accession: 'c', transactionCode: 'P', personCik: 'FHabc1234567',
            source: 'finnhub',
            acceptedAt: new Date(ASOF.getTime() - 20 * DAY_MS) }),
        ],
      }],
    });
    const row = evaluateForm4InsiderComposite(inputs).perTickerRows[0];
    // Cluster identity EDGAR-only → only 2 distinct → flag OFF (D1).
    assert.equal(row.insiderClusterBuyFlag, false);
    // Raw count stays dual-source (D3) → all 3 P trades counted.
    assert.equal(row.insiderBuyCount90d, 3);
    assert.equal(row.insiderBuyerCount90d, 3);
    // Source-mix label makes the split honest (D3/D4).
    assert.deepEqual(row.insiderCountSourceMix, { edgar: 2, finnhub: 1 });
  });

  it('T-F4-ADR052-4: sector cluster-rate ignores Finnhub rows (D1/D4 defense-in-depth)', () => {
    // Baseline centered on the SAME rate a single cluster-ticker would produce
    // (1/30) so we can read the cluster count straight off clusterRateT.
    // ADR-054: lay the non-zero baseline days as ISOLATED events (≥ EVENT_FLOOR=20
    // independent events) so the control sector clears the event-floor guard — a
    // contiguous run is ONE event and would be suppressed.
    const baseline: number[] = [];
    for (let i = 0; i < 25; i++) {
      baseline.push(0.02 + ((i % 4) - 1.5) * 0.005);
      baseline.push(0);
    }

    // Contaminated sector: ONE ticker with 1 EDGAR + 2 Finnhub buyers → the
    // EDGAR-only cluster count is 1 (< threshold 3) → 0 cluster tickers →
    // sector cluster-rate = 0 despite 3 RAW distinct person_ciks.
    const contaminated = makeInputs({
      sectors: [{
        sector: 'Information Technology', sectorSize: 30,
        trades: [
          makeTrade({ issuerTicker: 'AAA', accession: 'e1', transactionCode: 'P',
            personCik: '0001000001', source: EDGAR_CANONICAL_SOURCE }),
          makeTrade({ issuerTicker: 'AAA', accession: 'f1', transactionCode: 'P',
            personCik: 'FH1111111111', source: 'finnhub' }),
          makeTrade({ issuerTicker: 'AAA', accession: 'f2', transactionCode: 'P',
            personCik: 'FH2222222222', source: 'finnhub' }),
        ],
        baseline2y: baseline, baseline2ySell: [],
      }],
    });
    const snapBad = evaluateForm4InsiderComposite(contaminated);
    // The cluster rate is 0 (Finnhub excluded from identity) — NOT a positive
    // cluster. maxAggregateZ may be negative (rate 0 below the ~0.02 baseline
    // mean is a legitimate symmetric anomaly, same posture as G2-SELL-F4-4),
    // but it must NOT reflect a positive cluster.
    assert.ok(
      snapBad.maxAggregateZ == null || snapBad.maxAggregateZ <= 0,
      'Finnhub-contaminated sector produces NO positive cluster (rate 0)',
    );
    // No flagged sector carries a positive clusterRateT.
    for (const f of snapBad.flaggedSectors) {
      assert.equal(f.clusterRateT, 0, 'contaminated sector rate is 0, not a real cluster');
    }

    // CONTROL: the SAME 3 distinct buyers but ALL EDGAR → cluster fires → rate
    // = 1/30 > 0 → positive z → flagged with a positive rate. This proves the
    // exclusion in the contaminated case is the Finnhub source, not the data.
    const control = makeInputs({
      sectors: [{
        sector: 'Information Technology', sectorSize: 30,
        trades: [
          makeTrade({ issuerTicker: 'AAA', accession: 'e1', transactionCode: 'P',
            personCik: '0001000001', source: EDGAR_CANONICAL_SOURCE }),
          makeTrade({ issuerTicker: 'AAA', accession: 'e2', transactionCode: 'P',
            personCik: '0001000002', source: EDGAR_CANONICAL_SOURCE }),
          makeTrade({ issuerTicker: 'AAA', accession: 'e3', transactionCode: 'P',
            personCik: '0001000003', source: EDGAR_CANONICAL_SOURCE }),
        ],
        baseline2y: baseline, baseline2ySell: [],
      }],
    });
    const snapGood = evaluateForm4InsiderComposite(control);
    assert.equal(snapGood.flaggedSectors.length, 1);
    assertClose(snapGood.flaggedSectors[0].clusterRateT, 1 / 30);
    assert.ok((snapGood.maxAggregateZ ?? -1) > 0, 'all-EDGAR cluster yields a positive z');
  });

  it('T-F4-ADR052-5: an absent/empty source is fail-closed (dropped from cluster identity)', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        trades: [
          makeTrade({ accession: 'a', transactionCode: 'P', personCik: '0001000001', source: '' }),
          makeTrade({ accession: 'b', transactionCode: 'P', personCik: '0001000002', source: '' }),
          makeTrade({ accession: 'c', transactionCode: 'P', personCik: '0001000003', source: '' }),
        ],
      }],
    });
    const row = evaluateForm4InsiderComposite(inputs).perTickerRows[0];
    // None are EDGAR → no cluster identity → flag OFF; raw count still 3.
    assert.equal(row.insiderClusterBuyFlag, false);
    assert.equal(row.insiderBuyCount90d, 3);
    assert.deepEqual(row.insiderCountSourceMix, { edgar: 0, finnhub: 3 });
  });
});

// ── ADR-053 (S96-163) — empirical-exceedance aggregate statistic ─────────────
//
// Replaces the Gaussian z on the sparse, zero-inflated EDGAR-only cluster-rate.
// Statistic: p = (#{baseline ≥ today} + 1)/(n + 1); zEmp = max(0, invNormCDF(1−p)).
// Guards (both α-derived): n ≥ MIN_Z_BASELINE AND m ≥ ⌈α·(n+1)⌉ non-zero days.

/** Build a baseline with `events` ISOLATED non-zero days (each separated by a
 *  single zero) — i.e. `events` distinct maximal non-zero runs — padded with
 *  trailing zeros to reach total length `n`. Used to construct fixtures with a
 *  precise `effectiveEvents` count under the ADR-054 event-floor guard. The
 *  non-zero value (`val`) is kept small so a larger `today` exceeds every
 *  baseline day. */
function makeEventBaseline(events: number, n: number, val = 0.01): number[] {
  const b: number[] = [];
  for (let i = 0; i < events; i++) {
    b.push(val); // an isolated non-zero event
    if (b.length < n) b.push(0); // a zero break before the next event
  }
  while (b.length < n) b.push(0);
  return b.slice(0, n);
}

describe('countNonZeroRuns (ADR-054 D1)', () => {
  it('T-F4-ADR054-RUN-1: all-zero series → 0 events', () => {
    assert.equal(countNonZeroRuns([0, 0]), 0);
    assert.equal(countNonZeroRuns([]), 0);
    assert.equal(countNonZeroRuns([0, 0, 0, 0, 0]), 0);
  });

  it('T-F4-ADR054-RUN-2: a single contiguous plateau → 1 event (the OQ-C36-1 collapse)', () => {
    assert.equal(countNonZeroRuns([1, 1, 1]), 1);
    // A 30-day cluster-window plateau collapses to ONE event.
    assert.equal(countNonZeroRuns(Array.from({ length: 30 }, () => 0.045)), 1);
  });

  it('T-F4-ADR054-RUN-3: alternating non-zero/zero → one event per non-zero', () => {
    assert.equal(countNonZeroRuns([1, 0, 1, 0, 1]), 3);
  });

  it('T-F4-ADR054-RUN-4: leading and trailing runs both counted', () => {
    assert.equal(countNonZeroRuns([1, 0, 0, 1]), 2); // leading + trailing
    assert.equal(countNonZeroRuns([0, 1, 0, 1, 0]), 2); // interior runs only
    assert.equal(countNonZeroRuns([2, 2, 0, 0, 3, 3, 3]), 2); // two plateaus
    assert.equal(countNonZeroRuns([0, 2, 2, 0, 3]), 2);
  });

  it('T-F4-ADR054-RUN-5: strictly-positive only — negatives and zeros break runs', () => {
    // The cluster-rate is always ≥ 0 in practice, but pin the `> 0` semantic.
    assert.equal(countNonZeroRuns([1, -1, 1]), 2);
    assert.equal(countNonZeroRuns([0.001, 0.002]), 1); // small positives still count
  });
});

describe('computeEmpiricalExceedance (ADR-053 statistic + ADR-054 event guard)', () => {
  const ALPHA = FORM_4_EXCEEDANCE_ALPHA;

  it('T-F4-ADR053-1: zero-inflation 14σ→insufficient_data (the Comm-Svcs regression test)', () => {
    // Communication Services 2026-04-30 reproduction: 202 zeros + 1 non-zero,
    // today = 1/22 (one clustered ticker). The OLD Gaussian z scored this at
    // 14.18σ; under ADR-054 it is insufficient_data because the baseline contains
    // exactly ONE independent event (effectiveEvents=1 < EVENT_FLOOR=20).
    const baseline = [
      ...Array.from({ length: 202 }, () => 0),
      0.03, // the lone non-zero baseline day → one event
    ];
    const today = 1 / 22; // 0.0455 — one ordinary clustered ticker
    const r = computeEmpiricalExceedance(today, baseline);
    assert.equal(r.baselineSize, 203);
    assert.equal(r.effectiveEvents, 1); // ADR-054 guard metric: one event
    assert.equal(r.effectiveSample, 1); // diagnostic m: one non-zero day
    // effectiveEvents=1 < EVENT_FLOOR=20 → guard-suppressed (NOT a fabricated 14σ).
    assert.equal(r.insufficientData, true);
    assert.equal(r.exceedance, null);
    assert.equal(r.zEmp, null);
  });

  it('T-F4-ADR054-1: the OQ-C36-1 fix — a single ~30-day plateau (m passes the OLD day-count floor) → insufficient_data, effectiveEvents=1', () => {
    // A 30-day cluster-window plateau at rate 1/22, padded with zeros to n ≥ 30.
    // m = 30 non-zero days, n = 240 → the RETIRED ADR-053 day-count floor was
    // ⌈0.05·241⌉ = 13, and m=30 ≥ 13 WOULD HAVE PASSED (the v3 bug: the plateau
    // window-smears one event into 30 "effective" days). ADR-054 counts EVENTS:
    // the plateau is ONE event, 1 < EVENT_FLOOR=20 → insufficient_data. This is
    // the exact false-confidence ADR-054 closes.
    const plateau = Array.from({ length: 30 }, () => 1 / 22);
    const baseline = [...plateau, ...Array.from({ length: 210 }, () => 0)];
    const today = 2 / 22; // even an elevated rate must NOT fire on one event
    const r = computeEmpiricalExceedance(today, baseline);
    assert.equal(r.baselineSize, 240);
    assert.equal(r.effectiveSample, 30); // m=30: the OLD floor (⌈α(n+1)⌉=13) PASSED
    assert.ok(r.effectiveSample >= Math.ceil(ALPHA * (240 + 1)),
      'sanity: m clears the retired day-count floor, proving the regression is real');
    assert.equal(r.effectiveEvents, 1); // ADR-054: ONE independent event
    assert.equal(r.insufficientData, true, 'one event < EVENT_FLOOR → suppressed');
    assert.equal(r.exceedance, null);
    assert.equal(r.zEmp, null);
  });

  it('T-F4-ADR053-2: cold-start (empty baseline) → insufficient_data', () => {
    const r = computeEmpiricalExceedance(0.1, []);
    assert.equal(r.baselineSize, 0);
    assert.equal(r.effectiveEvents, 0);
    assert.equal(r.effectiveSample, 0);
    assert.equal(r.insufficientData, true);
    assert.equal(r.exceedance, null);
    assert.equal(r.zEmp, null);
  });

  it('T-F4-ADR053-2b: resolution floor — n < MIN_Z_BASELINE → insufficient_data', () => {
    // 29 isolated non-zero days (would clear the EVENT_FLOOR=20 event guard) but
    // n=29 < 30 → the resolution floor rejects it independently.
    const baseline = makeEventBaseline(MIN_Z_BASELINE - 1, MIN_Z_BASELINE - 1, 0.01);
    const r = computeEmpiricalExceedance(0.5, baseline);
    assert.equal(r.baselineSize, MIN_Z_BASELINE - 1);
    assert.equal(r.insufficientData, true);
    assert.equal(r.zEmp, null);
  });

  it('T-F4-ADR054-2: event-floor boundary — EVENT_FLOOR events valid; EVENT_FLOOR−1 insufficient', () => {
    // EXACTLY EVENT_FLOOR (20) isolated non-zero events → passes the event guard.
    // n must also be ≥ MIN_Z_BASELINE (30); makeEventBaseline pads to n=50.
    const baselineAtFloor = makeEventBaseline(EVENT_FLOOR, 50, 0.01);
    const atFloor = computeEmpiricalExceedance(0.5, baselineAtFloor);
    assert.equal(atFloor.effectiveEvents, EVENT_FLOOR);
    assert.equal(atFloor.baselineSize, 50);
    assert.equal(atFloor.insufficientData, false, 'effectiveEvents === EVENT_FLOOR must be VALID');
    assert.ok(atFloor.exceedance != null && atFloor.zEmp != null);

    // EVENT_FLOOR − 1 (19) isolated events → insufficient_data.
    const baselineBelow = makeEventBaseline(EVENT_FLOOR - 1, 50, 0.01);
    const below = computeEmpiricalExceedance(0.5, baselineBelow);
    assert.equal(below.effectiveEvents, EVENT_FLOOR - 1);
    assert.equal(below.insufficientData, true, 'effectiveEvents === EVENT_FLOOR−1 must be insufficient');
    assert.equal(below.zEmp, null);
  });

  it('T-F4-ADR053-4: genuine anomaly — today above a baseline with ≥ 20 independent events → fires, zEmp BOUNDED (never 14)', () => {
    // 50 ISOLATED non-zero days (effectiveEvents=50 ≥ EVENT_FLOOR) at small rates,
    // padded with zeros to n=100; today = 0.30 exceeds every non-zero day →
    // exceedance = 1/101 ≈ 0.0099 ≤ α; zEmp ≈ invNormCDF(0.99) ≈ 2.33 (bounded).
    const baseline = makeEventBaseline(50, 100, 0.02);
    const today = 0.30;
    const r = computeEmpiricalExceedance(today, baseline);
    assert.equal(r.effectiveEvents, 50);
    assert.equal(r.insufficientData, false);
    assert.ok(r.exceedance != null && r.exceedance <= ALPHA, `exceedance ${r.exceedance} must be ≤ α`);
    assert.ok(r.zEmp != null && r.zEmp >= 1.645, `zEmp ${r.zEmp} must clear the one-sided 95% quantile`);
    assert.ok(r.zEmp != null && r.zEmp < 3, `zEmp ${r.zEmp} must be BOUNDED, never a fabricated 14σ`);
  });

  it('T-F4-ADR053-5: invNormCDF(1−p) clamp — today below baseline median → zEmp clamped to 0 (not negative/NaN, distinct from null)', () => {
    // Baseline with ≥ 20 independent events (so the statistic is VALID), all
    // non-zero values ≥ 0.01; today = 0 is below every non-zero day → geCount
    // counts only the zeros... but `>=` includes them, so p = (n+1)/(n+1) = 1 →
    // 1−p = 0 → zEmp clamped to 0. Distinct from null (the statistic IS valid).
    const baseline = makeEventBaseline(30, 60, 0.01);
    const r = computeEmpiricalExceedance(0, baseline);
    assert.equal(r.effectiveEvents, 30);
    assert.equal(r.insufficientData, false);
    assert.equal(r.exceedance, 1); // all 60 baseline days ≥ 0
    assert.equal(r.zEmp, 0); // clamped, NOT null and NOT negative/NaN
    assert.ok(Number.isFinite(r.zEmp as number));
  });

  it('T-F4-ADR053-6: value null (degenerate sector) → insufficient_data', () => {
    const baseline = makeEventBaseline(30, 60, 0.05);
    const r = computeEmpiricalExceedance(null, baseline);
    assert.equal(r.insufficientData, true);
    assert.equal(r.zEmp, null);
  });

  it('T-F4-ADR053-7: NaN/Infinity baseline entries are filtered from n, m, and the event count', () => {
    // 5 leading finite values (3 of them non-zero, contiguous after filtering →
    // ONE run) interleaved with NaN/Infinity, then 30 contiguous non-zero days.
    // After filtering: [0.1, 0.2, 0.3, 0.05×30] = all contiguous non-zero → 1 run.
    const baseline = [0.1, NaN, 0.2, Infinity, 0.3,
      ...Array.from({ length: 30 }, () => 0.05)];
    const r = computeEmpiricalExceedance(0.5, baseline);
    assert.equal(r.baselineSize, 33); // 3 + 30 finite (NaN + Infinity dropped)
    assert.equal(r.effectiveSample, 33); // all finite entries are > 0
    assert.equal(r.effectiveEvents, 1); // contiguous after compaction → ONE event
    // One event < EVENT_FLOOR → insufficient (the finite filter does not create
    // spurious run breaks).
    assert.equal(r.insufficientData, true);
  });
});

describe('flagForm4ClusterEmpirical (ADR-053 firing rule)', () => {
  const ALPHA = FORM_4_EXCEEDANCE_ALPHA;
  it('fires when any valid sector has p ≤ α', () => {
    assert.equal(flagForm4ClusterEmpirical([0.5, 0.2, ALPHA]), true); // boundary p === α fires
    assert.equal(flagForm4ClusterEmpirical([0.01, 0.9]), true);
  });
  it('does not fire when all p > α', () => {
    assert.equal(flagForm4ClusterEmpirical([0.06, 0.5, 1.0]), false);
  });
  it('guard-suppressed (null) sectors cannot fire', () => {
    assert.equal(flagForm4ClusterEmpirical([null, null, null]), false);
    assert.equal(flagForm4ClusterEmpirical([null, 0.5]), false);
  });
});

describe('evaluateForm4InsiderComposite — ADR-053 aggregate end-to-end', () => {
  it('T-F4-ADR053-E2E-1: a zero-inflated sector is guard-suppressed → no flag, no fabricated maxAggregateZ', () => {
    // ONE sector whose EDGAR-only baseline is 202 zeros + 1 non-zero (the
    // Comm-Svcs shape), today = 1 clustered ticker in a sector of 22.
    const baseline = [
      ...Array.from({ length: 202 }, () => 0),
      0.0455,
    ];
    // Build today's trades for ONE cluster ticker (3 distinct EDGAR insiders).
    const trades: InsiderTrade[] = [];
    for (let pi = 0; pi < 3; pi++) {
      trades.push(makeTrade({
        issuerTicker: 'XYZ', accession: `xyz-${pi}`, transactionCode: 'P',
        personCik: `00010000${pi}1`, source: EDGAR_CANONICAL_SOURCE,
        acceptedAt: new Date(ASOF.getTime() - (3 + pi) * DAY_MS),
      }));
    }
    const inputs = makeInputs({
      sectors: [{
        sector: 'Communication Services', sectorSize: 22,
        trades, baseline2y: baseline, baseline2ySell: [],
      }],
    });
    const snap = evaluateForm4InsiderComposite(inputs);
    // The whole point: NO fabricated σ. Guard-suppressed → null + no flag.
    assert.equal(snap.maxAggregateZ, null);
    assert.equal(snap.maxAggregateZSector, null);
    assert.equal(snap.form4ClusterFlag, false);
    assert.equal(snap.flaggedSectors.length, 0);
    // The aggregate layer DID evaluate (sectorSize > 0).
    assert.equal(snap.inputsAvailableAggregate, 1);
  });

  it('T-F4-ADR053-E2E-2: a genuine anomaly with ≥ 20 independent events fires with a bounded zEmp', () => {
    // ADR-054: the baseline needs ≥ EVENT_FLOOR=20 distinct INDEPENDENT events
    // (maximal non-zero runs). Lay 100 isolated small non-zero days (each
    // separated by a zero) → 100 events, n=200; today's 0.2 rate exceeds every
    // baseline day → exceedance ≤ α → fires with a bounded zEmp.
    const baseline: number[] = [];
    for (let i = 0; i < 100; i++) {
      baseline.push(0.005 + (i / 100) * 0.02); // isolated non-zero event (≤ 0.025)
      baseline.push(0);
    }
    // 6 cluster-buy tickers in a sector of 30 → rate 0.2 exceeds all baseline.
    const trades: InsiderTrade[] = [];
    for (let ti = 0; ti < 6; ti++) {
      for (let pi = 0; pi < 3; pi++) {
        trades.push(makeTrade({
          issuerTicker: `T${ti}`, accession: `T${ti}-${pi}`, transactionCode: 'P',
          personCik: `0001${ti}${pi}00001`, source: EDGAR_CANONICAL_SOURCE,
          acceptedAt: new Date(ASOF.getTime() - (5 + pi * 2) * DAY_MS),
        }));
      }
    }
    const snap = evaluateForm4InsiderComposite(makeInputs({
      sectors: [{
        sector: 'Information Technology', sectorSize: 30,
        trades, baseline2y: baseline, baseline2ySell: [],
      }],
    }));
    assert.equal(snap.form4ClusterFlag, true);
    assert.equal(snap.flaggedSectors.length, 1);
    assert.ok(snap.maxAggregateZ != null && snap.maxAggregateZ >= 1.645);
    assert.ok(snap.maxAggregateZ != null && snap.maxAggregateZ < 3,
      `maxAggregateZ ${snap.maxAggregateZ} must be bounded, never 14σ`);
    assert.equal(snap.maxAggregateZSector, 'Information Technology');
  });
});
